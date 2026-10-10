import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Host-side `/review` and `/spec` slash commands. The plugin only assembles a
 * payload and routes it to a subagent; every judgement lives in the prompt
 * files under `~/.dsh/prompts/`, which are re-read on every invocation.
 * @module @local/dsh-review-spec-commands
 */
const name = 'dsh-review-spec-commands';
const inject = ['commands', 'subagents'];

const SUBAGENT_PROVIDER = 'spawn';
const DEFAULT_REVIEW_ROUTE = Object.freeze({ provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'medium' });
const SPEC_EFFORT = 'low';
const REVIEW_TOOL_ALLOW = Object.freeze(['read', 'grep', 'glob']);
const SPEC_TOOL_ALLOW = Object.freeze([]);
const EFFORT_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const RATE_WINDOW_MS = 5 * 60 * 60 * 1000;
const DEFAULT_PAYLOAD_CAP_BYTES = 200 * 1024;
const DEFAULT_RATE_CAP = 15;

/** In-process count of /review delegations currently running; the durable log only learns about them at completion. */
let inFlightReviews = 0;

const GIT_TIMEOUT_MS = 30000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;

const LOCK_FILE_NAMES = new Set([
	'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
	'Cargo.lock', 'Gemfile.lock', 'composer.lock', 'poetry.lock', 'Pipfile.lock',
	'go.sum', 'Podfile.lock', 'mix.lock', 'pubspec.lock', 'flake.lock', 'conda-lock.yml'
]);

/** Distinct refusal categories so the usage log carries a precise outcome. */
class CommandFailure extends Error {
	constructor(outcome, message) {
		super(message);
		this.outcome = outcome;
	}
}

function promptsDir() {
	return path.join(os.homedir(), '.dsh', 'prompts');
}

function logPath() {
	return path.join(os.homedir(), '.dsh', 'logs', 'commands.jsonl');
}

function normalizeConfig(raw) {
	const config = { payloadCapBytes: DEFAULT_PAYLOAD_CAP_BYTES, rateCap: DEFAULT_RATE_CAP, reviewProvider: undefined, reviewModel: undefined, reviewEffort: undefined };
	if (raw === undefined || raw === null) return config;
	if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${name}: config must be an object`);
	for (const key of ['payloadCapBytes', 'rateCap']) {
		if (raw[key] === undefined) continue;
		if (!Number.isSafeInteger(raw[key]) || raw[key] < 1) throw new Error(`${name}: config.${key} must be a positive integer, got ${JSON.stringify(raw[key])}`);
		config[key] = raw[key];
	}
	for (const key of ['reviewProvider', 'reviewModel', 'reviewEffort']) {
		if (raw[key] === undefined) continue;
		if (typeof raw[key] !== 'string' || raw[key].trim().length === 0) throw new Error(`${name}: config.${key} must be a non-empty string, got ${JSON.stringify(raw[key])}`);
		config[key] = raw[key].trim();
	}
	if ((config.reviewProvider === undefined) !== (config.reviewModel === undefined)) {
		throw new Error(`${name}: config.reviewProvider and config.reviewModel must be set together (provider/model route halves)`);
	}
	if (config.reviewEffort !== undefined && !EFFORT_LEVELS.has(config.reviewEffort)) {
		throw new Error(`${name}: config.reviewEffort must be one of ${[...EFFORT_LEVELS].join(', ')}, got ${JSON.stringify(config.reviewEffort)}`);
	}
	return config;
}

/** Reviewer route: config override on top of the built-in default; a model without an explicit effort keeps the default effort. */
function resolveReviewRoute(config) {
	return {
		provider: config.reviewProvider ?? DEFAULT_REVIEW_ROUTE.provider,
		model: config.reviewModel ?? DEFAULT_REVIEW_ROUTE.model,
		reasoningEffort: config.reviewEffort ?? DEFAULT_REVIEW_ROUTE.reasoningEffort
	};
}

/** Split a `provider/model` route string on the first slash; model ids may themselves contain slashes (local gguf paths). */
function parseModelRoute(value) {
	const slash = value.indexOf('/');
	if (slash === -1 || slash === value.length - 1) {
		throw new CommandFailure('error', `--model expects <provider>/<model>, got ${JSON.stringify(value)} (model ids may contain slashes; the provider is the part before the first one)`);
	}
	return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

/** Read a prompt file at call time; a missing file is a loud error with the expected path. */
async function readPromptFile(file) {
	const fullPath = path.join(promptsDir(), file);
	let text;
	try {
		text = await fs.readFile(fullPath, 'utf8');
	} catch (error) {
		throw new CommandFailure('missing-prompt', `prompt file is missing or unreadable: ${fullPath} (${error.code ?? error.message}). Create that file; there is no built-in fallback prompt.`);
	}
	if (text.trim().length === 0) throw new CommandFailure('missing-prompt', `prompt file is empty: ${fullPath}. Fill it in; there is no built-in fallback prompt.`);
	return text;
}

function cwdOf(invocation) {
	const cwd = invocation.agent?.session?.header?.cwd;
	if (typeof cwd !== 'string' || cwd.length === 0) throw new CommandFailure('error', 'cannot determine the session working directory (agent.session.header.cwd is unavailable)');
	return cwd;
}

function git(cwd, args) {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }, (error, stdout, stderr) => {
			if (error) {
				const detail = typeof stderr === 'string' && stderr.trim().length > 0 ? stderr.trim().split('\n').slice(0, 3).join(' | ') : error.message;
				reject(new CommandFailure('error', `git ${args[0]} failed in ${cwd}: ${detail}`));
				return;
			}
			resolve(stdout);
		});
	});
}

/** Diff mode needs a work tree; name that requirement instead of relaying git's pathspec fallback error. */
async function assertInsideWorkTree(cwd) {
	const inside = await new Promise((resolve) => {
		execFile('git', ['rev-parse', '--is-inside-work-tree'], { cwd, timeout: GIT_TIMEOUT_MS }, (error, stdout) => {
			resolve(error === null && stdout.trim() === 'true');
		});
	});
	if (!inside) throw new CommandFailure('error', `diff mode requires a git work tree: ${cwd} is not inside one (git rev-parse --is-inside-work-tree failed)`);
}

/** Best-effort .gitignore check on the resolved path: outside a git repository the file is admitted. */
async function assertNotIgnored(cwd, absolutePath) {
	let resolved = absolutePath;
	try {
		resolved = await fs.realpath(absolutePath);
	} catch {
		// an unreadable target fails loudly at read time; there is nothing to ignore-check
	}
	const relative = path.relative(cwd, resolved);
	if (relative.startsWith('..') || path.isAbsolute(relative)) return;
	const ignored = await new Promise((resolve) => {
		execFile('git', ['check-ignore', '-q', '--', relative], { cwd, timeout: GIT_TIMEOUT_MS }, (error) => {
			if (error === null) return resolve(true);
			if (error.code === 1) return resolve(false);
			resolve(false); // not a git repository: no ignore rules apply
		});
	});
	if (ignored) throw new CommandFailure('error', `refused: ${relative} matches .gitignore and is excluded from review payloads`);
}

function assertNotLockFile(absolutePath) {
	const base = path.basename(absolutePath);
	if (LOCK_FILE_NAMES.has(base)) throw new CommandFailure('error', `refused: ${base} is a lock file and is excluded from review payloads`);
}

async function assertNotBinary(absolutePath, buffer) {
	if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) throw new CommandFailure('error', `refused: ${path.basename(absolutePath)} looks like a binary file (NUL byte in the first ${BINARY_SNIFF_BYTES} bytes) and is excluded from review payloads`);
}

function lockFileExcludes() {
	return [...LOCK_FILE_NAMES].map((entry) => `:(exclude,glob)**/${entry}`);
}

async function buildDiffPayload(cwd, base) {
	if (base.startsWith('-')) throw new CommandFailure('error', `refused: diff base ${JSON.stringify(base)} looks like a git option, not a revision`);
	await assertInsideWorkTree(cwd);
	const stdout = await git(cwd, ['diff', base, '--', '.', ...lockFileExcludes()]);
	if (stdout.trim().length === 0) {
		throw new CommandFailure('empty-diff', `empty diff: \`git diff ${base}\` produced no changes (lock files excluded). Nothing to review — commit or stage work first, or name a different base.`);
	}
	return stdout;
}

async function buildFilePayload(cwd, target, capBytes) {
	const absolutePath = path.resolve(cwd, target);
	assertNotLockFile(absolutePath);
	await assertNotIgnored(cwd, absolutePath);
	let stat;
	try {
		stat = await fs.stat(absolutePath);
	} catch (error) {
		throw new CommandFailure('error', `cannot read ${target}: ${error.code ?? error.message}`);
	}
	if (!stat.isFile()) throw new CommandFailure('error', `refused: ${target} is not a regular file`);
	if (stat.size > capBytes) throw new CommandFailure('oversized', `payload cap exceeded: ${target} alone is ${stat.size} bytes on disk, over the configured cap of ${capBytes} bytes (line numbers would add more). Narrow the review target or raise payloadCapBytes in the plugin config. The file was NOT read and nothing was truncated.`);
	let buffer;
	try {
		buffer = await fs.readFile(absolutePath);
	} catch (error) {
		throw new CommandFailure('error', `cannot read ${target}: ${error.code ?? error.message}`);
	}
	await assertNotBinary(absolutePath, buffer);
	const lines = buffer.toString('utf8').split('\n');
	const width = String(lines.length).length;
	const numbered = lines.map((line, index) => `${String(index + 1).padStart(width)}\t${line}`).join('\n');
	return `File: ${absolutePath}\n\n${numbered}`;
}

/**
 * Parse `[<path> | diff [<base>]] [--model <provider/model>] [--confirm] [-- <focus note>]`.
 * The focus note is everything after the first standalone ` -- ` separator.
 */
function parseReviewInput(rawInput) {
	const separator = rawInput.search(/\s--(?:\s|$)/);
	let argsPart = rawInput;
	let focus;
	if (separator !== -1) {
		argsPart = rawInput.slice(0, separator);
		focus = rawInput.slice(separator).replace(/^\s--\s?/, '').trim();
		if (focus.length === 0) focus = undefined;
	}
	const tokens = argsPart.trim().split(/\s+/).filter((token) => token.length > 0);
	let confirm = false;
	let model;
	const positional = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === '--confirm') {
			confirm = true;
			continue;
		}
		if (token === '--model') {
			if (index + 1 >= tokens.length) throw new CommandFailure('error', 'usage: /review [diff [<base>] | <path>] [--model <provider/model>] [-- <focus note>] — --model expects a value');
			model = tokens[index + 1];
			index += 1;
			continue;
		}
		positional.push(token);
	}
	if (positional.length === 0) return { mode: 'diff', base: 'HEAD', focus, confirm, model };
	if (positional[0] === 'diff') {
		if (positional.length > 2) throw new CommandFailure('error', `usage: /review [diff [<base>] | <path>] [--model <provider/model>] [-- <focus note>] — unexpected arguments: ${positional.slice(2).join(' ')}`);
		return { mode: 'diff', base: positional[1] ?? 'HEAD', focus, confirm, model };
	}
	if (positional.length > 1) throw new CommandFailure('error', `usage: /review [diff [<base>] | <path>] [--model <provider/model>] [-- <focus note>] — unexpected arguments after the path: ${positional.slice(1).join(' ')}`);
	return { mode: 'file', path: positional[0], focus, confirm, model };
}

/** Count successful /review delegations inside the rolling window from the durable log. */
async function countRecentReviews(cutoffIso) {
	let text;
	try {
		text = await fs.readFile(logPath(), 'utf8');
	} catch (error) {
		if (error.code === 'ENOENT') return 0;
		throw new CommandFailure('error', `rate guard cannot read the usage log ${logPath()}: ${error.code ?? error.message}`);
	}
	const cutoff = Date.parse(cutoffIso);
	let count = 0;
	for (const line of text.split('\n')) {
		if (line.trim().length === 0) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue; // a malformed line never consumes budget
		}
		if (record.command !== 'review' || record.outcome !== 'ok') continue;
		const ts = Date.parse(record.ts);
		if (Number.isFinite(ts) && ts >= cutoff) count += 1;
	}
	return count;
}

/** Count findings when the reviewer honoured the JSON-array contract. */
function countFindings(text) {
	const start = text.indexOf('[');
	const end = text.lastIndexOf(']');
	if (start === -1 || end === -1 || end < start) return null;
	try {
		const parsed = JSON.parse(text.slice(start, end + 1));
		return Array.isArray(parsed) ? parsed.length : null;
	} catch {
		return null;
	}
}

/** Provider-reported token usage of the settled child, when the runtime exposes it. */
function readChildUsage(ctx, childAgent) {
	try {
		const registry = ctx.get('sessionProjections');
		const session = childAgent?.session;
		if (registry === undefined || session === undefined) return null;
		const state = registry.stateOf(session, 'tokenUsage');
		if (state === undefined || state.totals === undefined) return null;
		const buckets = [state.totals.uncachedInputTokens, state.totals.cacheReadTokens, state.totals.cacheWriteTokens, state.totals.outputTokens];
		if (buckets.some((value) => !Number.isFinite(value))) return null;
		const input = buckets[0] + buckets[1] + buckets[2];
		if (input === 0 && buckets[3] === 0) return null;
		return { inputTokens: input, outputTokens: buckets[3] };
	} catch {
		return null;
	}
}

async function startChild(ctx, invocation, options) {
	const provider = ctx.subagents.getProvider(SUBAGENT_PROVIDER);
	if (provider === undefined) throw new CommandFailure('bridge-failure', `bridge failure: subagent provider "${SUBAGENT_PROVIDER}" is not registered (registered: ${ctx.subagents.list().join(', ') || 'none'})`);
	for (const capability of ['agentOptions', 'toolFilter']) {
		if (provider.capabilities?.[capability] !== true) throw new CommandFailure('bridge-failure', `bridge failure: subagent provider "${SUBAGENT_PROVIDER}" lacks the "${capability}" capability; the ${options.label} route cannot be enforced`);
	}
	let run;
	try {
		run = await ctx.subagents.start(SUBAGENT_PROVIDER, {
			label: options.label,
			prompt: [{ type: 'text', text: options.prompt }],
			parent: invocation.agent,
			signal: invocation.signal,
			agentOptions: options.agentOptions,
			toolFilter: { allow: options.toolAllow }
		});
	} catch (error) {
		throw new CommandFailure('bridge-failure', `bridge failure: could not start the ${options.label} subagent: ${error.message}`);
	}
	try {
		const result = await run.result;
		if (result.stopReason !== 'completed') {
			throw new CommandFailure('bridge-failure', `bridge failure: ${options.label} subagent ended with stopReason "${result.stopReason}"${result.diagnostic === undefined ? '' : `: ${result.diagnostic}`}`);
		}
		const text = result.output.filter((block) => block.type === 'text').map((block) => block.text).join('');
		if (text.trim().length === 0) throw new CommandFailure('bridge-failure', `bridge failure: ${options.label} subagent produced no text output`);
		const usage = readChildUsage(ctx, run.localAgent);
		return { text, usage };
	} finally {
		await run.dispose();
	}
}

async function appendUsageLog(record) {
	await fs.mkdir(path.dirname(logPath()), { recursive: true });
	await fs.appendFile(logPath(), `${JSON.stringify(record)}\n`, 'utf8');
}

async function handleReview(ctx, config, invocation) {
	const started = Date.now();
	let outcome = 'error';
	let payloadBytes = null;
	let findings = null;
	let usage = null;
	let result;
	let route = resolveReviewRoute(config);
	try {
		const parsed = parseReviewInput(invocation.rawInput ?? '');
		if (parsed.model !== undefined) route = { ...route, ...parseModelRoute(parsed.model) };
		const cwd = cwdOf(invocation);
		const promptText = await readPromptFile('review.md');
		const payload = parsed.mode === 'diff' ? await buildDiffPayload(cwd, parsed.base) : await buildFilePayload(cwd, parsed.path, config.payloadCapBytes);
		payloadBytes = Buffer.byteLength(payload, 'utf8');
		if (payloadBytes > config.payloadCapBytes) {
			throw new CommandFailure('oversized', `payload cap exceeded: the assembled payload is ${payloadBytes} bytes, over the configured cap of ${config.payloadCapBytes} bytes. Narrow the review target (a single file, a smaller base range) or raise payloadCapBytes in the plugin config. The payload was NOT truncated.`);
		}
		const recent = (await countRecentReviews(new Date(started - RATE_WINDOW_MS).toISOString())) + inFlightReviews;
		if (recent >= config.rateCap && !parsed.confirm) {
			throw new CommandFailure('rate-capped', `rate guard: ${recent} /review delegations in the last 5 hours reached the configured cap of ${config.rateCap} (remaining budget 0/${config.rateCap}). This invocation was refused and did not consume budget. Re-run the identical command with --confirm to proceed anyway.`);
		}
		let prompt = `${promptText.trimEnd()}\n\n${payload}`;
		if (parsed.focus !== undefined) prompt += `\n\nFocus note from the user:\n${parsed.focus}\n`;
		inFlightReviews += 1;
		let child;
		try {
			child = await startChild(ctx, invocation, {
				label: 'review',
				prompt,
				agentOptions: { ...route },
				toolAllow: REVIEW_TOOL_ALLOW
			});
		} finally {
			inFlightReviews -= 1;
		}
		findings = countFindings(child.text);
		usage = child.usage;
		outcome = 'ok';
		const remaining = Math.max(0, config.rateCap - recent - 1);
		const header = [
			`review complete — route ${route.provider}/${route.model} effort ${route.reasoningEffort}, payload ${payloadBytes} bytes, tools allowed to reviewer: ${REVIEW_TOOL_ALLOW.join(', ')}`,
			`rate budget: ${remaining}/${config.rateCap} remaining in the 5-hour window${parsed.confirm ? ' (proceeded via --confirm)' : ''}`,
			findings === null ? 'findings: count unavailable — reviewer output was not a bare JSON array; raw output follows' : `findings: ${findings}`
		].join('\n');
		result = { kind: 'success', text: `${header}\n\n${child.text}` };
	} catch (error) {
		if (error instanceof CommandFailure) {
			outcome = error.outcome;
			result = { kind: 'error', text: error.message };
		} else {
			outcome = 'error';
			result = { kind: 'error', text: `/review failed: ${error.message}` };
		}
	}
	const record = {
		ts: new Date().toISOString(),
		command: 'review',
		model: `${route.provider}/${route.model}`,
		effort: route.reasoningEffort,
		payloadBytes,
		inputTokens: usage?.inputTokens ?? null,
		outputTokens: usage?.outputTokens ?? null,
		durationMs: Date.now() - started,
		findings,
		outcome
	};
	if (usage === null && outcome === 'ok') record.tokensNote = 'token counts not exposed by the runtime for this run';
	try {
		await appendUsageLog(record);
	} catch (error) {
		result = { ...result, text: `${result.text ?? ''}\n\nWARNING: usage log write to ${logPath()} failed: ${error.message}` };
	}
	return result;
}

async function handleSpec(ctx, config, invocation) {
	const started = Date.now();
	let outcome = 'error';
	let usage = null;
	let route = null;
	let result;
	try {
		const task = (invocation.rawInput ?? '').trim();
		if (task.length === 0) throw new CommandFailure('error', 'usage: /spec <free-form task description>');
		const promptText = await readPromptFile('spec.md');
		const selection = ctx.get('agentDefaultModel')?.currentSelection();
		if (selection === undefined) throw new CommandFailure('error', 'cannot resolve the local default model route: the agentDefaultModel service is unavailable');
		route = `${selection.provider}/${selection.model}`;
		const agentOptions = { provider: selection.provider, model: selection.model, reasoningEffort: SPEC_EFFORT };
		const child = await startChild(ctx, invocation, {
			label: 'spec',
			prompt: `${promptText.trimEnd()}\n\n${task}`,
			agentOptions,
			toolAllow: SPEC_TOOL_ALLOW
		});
		usage = child.usage;
		outcome = 'ok';
		result = { kind: 'success', text: child.text };
	} catch (error) {
		if (error instanceof CommandFailure) {
			outcome = error.outcome;
			result = { kind: 'error', text: error.message };
		} else {
			outcome = 'error';
			result = { kind: 'error', text: `/spec failed: ${error.message}` };
		}
	}
	const record = {
		ts: new Date().toISOString(),
		command: 'spec',
		model: route,
		effort: SPEC_EFFORT,
		payloadBytes: null,
		inputTokens: usage?.inputTokens ?? null,
		outputTokens: usage?.outputTokens ?? null,
		durationMs: Date.now() - started,
		findings: null,
		outcome
	};
	if (usage === null && outcome === 'ok') record.tokensNote = 'token counts not exposed by the runtime for this run';
	try {
		await appendUsageLog(record);
	} catch (error) {
		result = { ...result, text: `${result.text ?? ''}\n\nWARNING: usage log write to ${logPath()} failed: ${error.message}` };
	}
	return result;
}

function apply(ctx, rawConfig) {
	const config = normalizeConfig(rawConfig);
	const disposeReview = ctx.commands.register({
		name: 'review',
		description: 'Review a diff or file with a fresh subagent (read/grep/glob only). Reviewer route: config reviewProvider/reviewModel or --model <provider/model>, default claude/claude-opus-5-5.',
		input: { hint: '[<path> | diff [<base>]] [--model <provider/model>] [-- <focus note>]' },
		recordInput: true,
		handler: (invocation) => handleReview(ctx, config, invocation)
	});
	const disposeSpec = ctx.commands.register({
		name: 'spec',
		description: 'Convert a rough task into a structured spec (default local route, low effort, no tools). Does not implement.',
		input: { hint: '<free-form task description>' },
		recordInput: true,
		handler: (invocation) => handleSpec(ctx, config, invocation)
	});
	return () => {
		disposeReview();
		disposeSpec();
	};
}

export { apply, inject, name };
