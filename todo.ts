import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";
type TodoAction = "create" | "create_many" | "update" | "delete" | "get" | "list" | "clear" | "finish" | "complete";

type FridayTask = {
	id: number;
	subject: string;
	description?: string;
	status: TaskStatus;
	activeForm?: string;
	blockedBy?: number[];
};

type FridayTodoState = {
	tasks: FridayTask[];
	nextId: number;
};

type TodoCreateManyItem = {
	subject?: string;
	description?: string;
	status?: TaskStatus;
	activeForm?: string;
	blockedBy?: number[];
};

type RegisterFridayTodoOptions = {
	todosFile: string;
	logError: (context: string, err: unknown) => void;
	onTodoVisibilityChange?: (hasTodos: boolean) => void;
};

const FRIDAY_RESET = "\x1b[0m";
const FRIDAY_DIM = "\x1b[38;5;245m";
const FRIDAY_MUTED = "\x1b[38;5;240m";
const FRIDAY_ACCENT = "\x1b[38;5;213m";
const FRIDAY_WARNING = "\x1b[38;5;215m";
const FRIDAY_SUCCESS = "\x1b[38;5;84m";
const FRIDAY_TEXT = "\x1b[38;5;255m";
const FRIDAY_ERROR = "\x1b[38;5;203m";
const MIN_PLAN_TASKS = 3;
const MAX_PLAN_TASKS = 8;
const MAX_TODO_LINES = 12;
const MAX_LINE_WIDTH = 72;

function asciiOnly(text: string): string {
	return text.replace(/…/g, "...").replace(/[^\x20-\x7E]/g, "");
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

function truncateAnsi(line: string, width: number): string {
	let visible = 0;
	let out = "";
	for (let i = 0; i < line.length; i++) {
		if (line[i] === "\x1b") {
			const match = line.slice(i).match(/^\x1b\[[0-9;]*[A-Za-z]/);
			if (match) {
				out += match[0];
				i += match[0].length - 1;
				continue;
			}
		}
		if (visible >= width - 3) return out + "..." + FRIDAY_RESET;
		out += line[i];
		visible++;
	}
	return out;
}

function statusGlyph(task: FridayTask): string {
	switch (task.status) {
		case "completed":
			return "x";
		case "in_progress":
			return ">";
		case "pending":
			return "o";
		case "deleted":
			return "!";
	}
}

function statusColor(task: FridayTask): string {
	switch (task.status) {
		case "completed":
			return FRIDAY_SUCCESS;
		case "in_progress":
			return FRIDAY_WARNING;
		case "pending":
			return FRIDAY_DIM;
		case "deleted":
			return FRIDAY_ERROR;
	}
}

function summarize(action: TodoAction, task?: FridayTask): string {
	if (!task) return action;
	return `${action}: #${task.id} ${task.subject}`;
}

function renderActionSummary(params: any): string {
	const action = String(params?.action ?? "").trim() || "todo";
	if (action === "create_many") {
		const count = Array.isArray(params.items) ? params.items.length : Array.isArray(params.subjects) ? params.subjects.length : 0;
		return `create ${count} tasks`;
	}
	if (action === "update" && params?.status === "completed" && Number.isInteger(Number(params?.id))) return `complete #${Number(params.id)}`;
	if (action === "update" && Number.isInteger(Number(params?.id))) return `update #${Number(params.id)}`;
	if ((action === "finish" || action === "complete") && Number.isInteger(Number(params?.id))) return `complete #${Number(params.id)}`;
	if (action === "finish" || action === "complete") return "complete active task";
	if (action === "create") return "append task";
	return action;
}

function normalizeBlockedBy(value: unknown): number[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const ids = value.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
	return ids.length > 0 ? [...new Set(ids)] : undefined;
}

function normalizeStatus(value: unknown): TaskStatus | undefined {
	return ["pending", "in_progress", "completed", "deleted"].includes(value as string) ? value as TaskStatus : undefined;
}

function validateSubject(subject: string): string {
	const trimmed = subject.trim().replace(/\s+/g, " ");
	if (!trimmed) throw new Error("todo task requires a non-empty subject");
	if (/^(fix|update|implement|work on|do it|misc|things?|stuff)$/i.test(trimmed)) {
		throw new Error(`todo task is too vague: ${trimmed}`);
	}
	return trimmed;
}

export function registerFridayTodo(pi: ExtensionAPI, options: RegisterFridayTodoOptions) {
	let state: FridayTodoState = { tasks: [], nextId: 1 };
	let lastNextId: number | undefined;
	let agentRunning = false;

	function setState(next: FridayTodoState) {
		state = {
			tasks: next.tasks.map((task) => ({ ...task, blockedBy: task.blockedBy ? [...task.blockedBy] : undefined })),
			nextId: next.nextId,
		};
		if (lastNextId !== undefined && state.nextId < lastNextId) lastNextId = undefined;
		lastNextId = state.nextId;
	}

	function resetDisplayState() {
		lastNextId = undefined;
	}

	function snapshot(): FridayTodoState {
		return {
			tasks: state.tasks.map((task) => ({ ...task, blockedBy: task.blockedBy ? [...task.blockedBy] : undefined })),
			nextId: state.nextId,
		};
	}

	function nonDeletedTasks(): FridayTask[] {
		return state.tasks.filter((task) => task.status !== "deleted");
	}

	function visibleTasks(): FridayTask[] {
		return nonDeletedTasks();
	}

	function openTasks(): FridayTask[] {
		return nonDeletedTasks().filter((task) => task.status === "pending" || task.status === "in_progress");
	}

	function activeTasks(): FridayTask[] {
		return nonDeletedTasks().filter((task) => task.status === "in_progress");
	}

	function hasOpenWork(tasks = nonDeletedTasks()): boolean {
		return tasks.some((task) => task.status === "pending" || task.status === "in_progress");
	}

	function counts(tasks: FridayTask[]) {
		return {
			total: tasks.length,
			completed: tasks.filter((task) => task.status === "completed").length,
		};
	}

	function dependenciesSatisfied(task: FridayTask): boolean {
		const deps = task.blockedBy ?? [];
		if (deps.length === 0) return true;
		return deps.every((id) => state.tasks.some((candidate) => candidate.id === id && candidate.status === "completed"));
	}

	function nextRunnablePendingTask(): FridayTask | undefined {
		return nonDeletedTasks().find((task) => task.status === "pending" && dependenciesSatisfied(task))
			?? nonDeletedTasks().find((task) => task.status === "pending");
	}

	function promoteNextPendingTask() {
		if (activeTasks().length > 0) return;
		const next = nextRunnablePendingTask();
		if (next) next.status = "in_progress";
	}

	function enforceSingleActiveTask() {
		const active = activeTasks();
		if (active.length > 1) {
			throw new Error(`todo list has ${active.length} in_progress tasks; keep exactly one active task`);
		}
		if (active.length === 0 && openTasks().length > 0) promoteNextPendingTask();
	}

	function clearCompletedPlanIfDone(force = false): boolean {
		const tasks = nonDeletedTasks();
		if (tasks.length === 0) return false;
		if (!tasks.every((task) => task.status === "completed")) return false;
		if (agentRunning && !force) return false;
		setState({ tasks: [], nextId: 1 });
		resetDisplayState();
		return true;
	}

	function renderStateSummary(action: TodoAction, summary: string): string {
		const tasks = nonDeletedTasks();
		if (tasks.length === 0) return summary;
		const taskCounts = counts(tasks);
		const active = activeTasks()[0];
		const lines = [summary, `Todo state: ${taskCounts.completed}/${taskCounts.total} complete.`];
		if (active) {
			lines.push(`Active now: #${active.id} ${active.subject}.`);
			lines.push(`Tracking rule: mark #${active.id} completed immediately when the work is actually done; do not batch completions at the end.`);
		} else if (tasks.every((task) => task.status === "completed")) {
			lines.push("All tasks complete. This completed list will remain visible until the next user turn starts.");
		} else {
			lines.push("No active task. Mark exactly one pending task in_progress before doing more work.");
		}
		if (action === "create_many") {
			lines.push("Track the user's directions as tasks. Update status as each direction is fulfilled, not after the whole response.");
		}
		return lines.join("\n");
	}

	function renderTodoLines(): string[] {
		const tasks = visibleTasks();
		if (tasks.length === 0) return [];
		const taskCounts = counts(tasks);
		const hasActive = tasks.some((task) => task.status === "in_progress");
		const lines = [`${hasActive ? FRIDAY_ACCENT : FRIDAY_DIM}Todo list - ${taskCounts.completed}/${taskCounts.total}${FRIDAY_RESET}`];
		const visible = tasks.slice(0, MAX_TODO_LINES - 1);
		for (let i = 0; i < visible.length; i++) {
			const task = visible[i]!;
			const isLast = i === visible.length - 1 && visible.length === tasks.length;
			const prefix = isLast ? "`-" : "|-";
			const status = `${statusColor(task)}${statusGlyph(task)}${FRIDAY_RESET}`;
			const subjectColor = task.status === "completed" ? FRIDAY_DIM : FRIDAY_TEXT;
			let line = `${FRIDAY_MUTED}${prefix}${FRIDAY_RESET} ${status} ${subjectColor}${asciiOnly(task.subject)}${FRIDAY_RESET}`;
			if (task.blockedBy && task.blockedBy.length > 0) {
				line += ` ${FRIDAY_DIM}deps ${task.blockedBy.map((id) => `#${id}`).join(",")}${FRIDAY_RESET}`;
			}
			lines.push(truncateAnsi(line, MAX_LINE_WIDTH));
		}
		if (tasks.length > visible.length) {
			lines.push(`${FRIDAY_MUTED}` + "`-" + ` +${tasks.length - visible.length} more${FRIDAY_RESET}`);
		}
		return lines;
	}

	function writeTodosFile(forceClearCompleted = false) {
		try {
			clearCompletedPlanIfDone(forceClearCompleted);
			mkdirSync(dirname(options.todosFile), { recursive: true });
			const content = renderTodoLines().join("\n");
			writeFileSync(options.todosFile, content, "utf-8");
			options.onTodoVisibilityChange?.(content.trim().length > 0);
		} catch (err) {
			options.logError("todo.writeTodosFile", err);
		}
	}

	function repairRestoredActiveState() {
		const active = activeTasks();
		if (active.length > 1) {
			for (const task of active.slice(1)) task.status = "pending";
		}
		if (activeTasks().length === 0 && openTasks().length > 0) promoteNextPendingTask();
	}

	function replayFromBranch(ctx: any) {
		try {
			const branch = ctx.sessionManager?.getBranch?.() ?? [];
			let restored: FridayTodoState = { tasks: [], nextId: 1 };
			for (const entry of branch) {
				const message = entry?.message;
				if (entry?.type !== "message" || message?.role !== "toolResult" || message?.toolName !== "todo") continue;
				const details = message.details;
				const candidate = details?.fridayTodoState ?? (Array.isArray(details?.tasks) ? { tasks: details.tasks, nextId: undefined } : undefined);
				if (!candidate || !Array.isArray(candidate.tasks)) continue;
				const tasks = candidate.tasks
					.filter((task: any) => typeof task?.id === "number" && typeof task?.subject === "string")
					.map((task: any) => ({
						id: task.id,
						subject: validateSubject(task.subject),
						description: typeof task.description === "string" ? task.description : undefined,
						status: normalizeStatus(task.status) ?? "pending",
						activeForm: typeof task.activeForm === "string" ? task.activeForm : undefined,
						blockedBy: normalizeBlockedBy(task.blockedBy),
					}));
				const maxId = tasks.reduce((max: number, task: FridayTask) => Math.max(max, task.id), 0);
				restored = { tasks, nextId: typeof candidate.nextId === "number" ? candidate.nextId : maxId + 1 };
			}
			setState(restored);
			if (!hasOpenWork()) setState({ tasks: [], nextId: 1 });
			else repairRestoredActiveState();
			resetDisplayState();
			writeTodosFile();
		} catch (err) {
			options.logError("todo.replayFromBranch", err);
		}
	}

	function findTask(id: number): FridayTask | undefined {
		return state.tasks.find((task) => task.id === id && task.status !== "deleted");
	}

	function clearCompletedBatchIfDone() {
		clearCompletedPlanIfDone(true);
	}

	function buildTask(params: TodoCreateManyItem): FridayTask {
		if (!params.subject || typeof params.subject !== "string") throw new Error("todo task requires subject");
		const status = normalizeStatus(params.status) ?? "pending";
		if (status === "deleted") throw new Error("todo.create_many cannot create deleted tasks");
		return {
			id: state.nextId++,
			subject: validateSubject(params.subject),
			description: typeof params.description === "string" ? params.description : undefined,
			status,
			activeForm: typeof params.activeForm === "string" ? params.activeForm : undefined,
			blockedBy: normalizeBlockedBy(params.blockedBy),
		};
	}

	function buildReminder(): string {
		const tasks = nonDeletedTasks();
		const active = activeTasks()[0];
		if (!active && tasks.length === 0) return "";
		const taskCounts = counts(tasks);
		const remaining = tasks
			.filter((task) => task.status !== "completed")
			.map((task) => `#${task.id} ${task.subject} [${task.status}]`)
			.join("; ");
		return [
			`Friday todo state: ${taskCounts.completed}/${taskCounts.total} complete.`,
			active ? `Current task: #${active.id} ${active.subject}.` : "No active task is set; set exactly one task in_progress before doing more work.",
			remaining ? `Remaining: ${remaining}.` : "No remaining open tasks.",
			"Follow the todo list as the execution plan. Do not start unrelated work; complete or update the active task before moving on.",
		].join("\n");
	}

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description: "Manage Friday's built-in todo list shown in the Friday tmux todo pane.",
		promptSnippet: "Manage Friday's built-in todo list shown in the Friday tmux todo pane",
		promptGuidelines: [
			"Use todo for substantial multi-step execution, when the user gives numbered directions, or when the user gives several requirements that must be tracked. Skip it for simple questions, single-command checks, read-only investigation, or reporting.",
			"Start a real plan with one todo create_many call containing 3-8 concrete tasks and exactly one in_progress task. Turn the user's directions into tracked tasks; do not keep requirements only in prose.",
			"Mark the current task completed immediately when that task is actually done. Never save completions for the end of the turn; delayed batch completion is a tracking failure.",
			"Before starting the next task, make sure exactly one task is in_progress. Complete or update the active task before moving on; do not replace an open list unless the user explicitly changes the plan.",
			"Completed-only lists remain visible through the end of the turn so the user can see the final ticks; they are cleared when the next turn starts.",
		],
		parameters: Type.Object({
			action: Type.String({ description: "One of: create, create_many, update, delete, get, list, clear, finish, complete. Complete/finish complete one task; clear is the only explicit list-wiping action." }),
			id: Type.Optional(Type.Number({ description: "Task id for update, delete, get, finish, or complete" })),
			subject: Type.Optional(Type.String({ description: "Short imperative subject for create or update" })),
			subjects: Type.Optional(Type.Array(Type.String({ description: "Task subject for create_many" }))),
			items: Type.Optional(Type.Array(Type.Object({
				subject: Type.String({ description: "Short imperative task subject" }),
				description: Type.Optional(Type.String({ description: "Longer task description" })),
				status: Type.Optional(Type.String({ description: "pending, in_progress, completed" })),
				activeForm: Type.Optional(Type.String({ description: "Present-continuous active label for in_progress tasks" })),
				blockedBy: Type.Optional(Type.Array(Type.Number())),
			}))),
			description: Type.Optional(Type.String({ description: "Longer task description" })),
			status: Type.Optional(Type.String({ description: "pending, in_progress, completed, deleted" })),
			activeForm: Type.Optional(Type.String({ description: "Present-continuous active label for in_progress tasks" })),
			blockedBy: Type.Optional(Type.Array(Type.Number())),
			addBlockedBy: Type.Optional(Type.Array(Type.Number())),
			removeBlockedBy: Type.Optional(Type.Array(Type.Number())),
			replace: Type.Optional(Type.Boolean({ description: "Explicitly replace an open todo list. Use only when the user changed the plan." })),
		}),
		async execute(_toolCallId, params: any) {
			const action = String(params.action ?? "").trim() as TodoAction;
			let affected: FridayTask | undefined;
			let affectedMany: FridayTask[] = [];

			if (action === "create") {
				clearCompletedBatchIfDone();
				if (nonDeletedTasks().length === 0) throw new Error("todo.create cannot start a plan; use create_many with 3-8 concrete tasks for substantial work, or skip todo for small work");
				affected = buildTask(params);
				state.tasks.push(affected);
				enforceSingleActiveTask();
			} else if (action === "create_many") {
				if (hasOpenWork() && params.replace !== true) throw new Error("todo.create_many rejected: an open todo list already exists; complete/update it or pass replace=true only for an explicit plan change");
				const items: TodoCreateManyItem[] = Array.isArray(params.items)
					? params.items
					: Array.isArray(params.subjects)
						? params.subjects.map((subject: unknown) => ({ subject: typeof subject === "string" ? subject : undefined }))
						: [];
				if (items.length === 0) throw new Error("todo.create_many requires items or subjects");
				if (items.length < MIN_PLAN_TASKS || items.length > MAX_PLAN_TASKS) throw new Error(`todo.create_many requires ${MIN_PLAN_TASKS}-${MAX_PLAN_TASKS} concrete tasks`);
				const activeCount = items.filter((item) => item.status === "in_progress").length;
				if (activeCount > 1) throw new Error("todo.create_many requires exactly one in_progress task, not multiple active tasks");
				if (activeCount === 0) items[0]!.status = "in_progress";
				setState({ tasks: [], nextId: 1 });
				resetDisplayState();
				affectedMany = items.map((item) => buildTask(item));
				state.tasks.push(...affectedMany);
				enforceSingleActiveTask();
			} else if (action === "update") {
				const id = Number(params.id);
				if (!Number.isInteger(id)) throw new Error("todo.update requires id");
				affected = findTask(id);
				if (!affected) throw new Error(`todo #${id} not found`);
				const nextStatus = params.status === undefined ? undefined : normalizeStatus(params.status);
				if (params.status !== undefined && !nextStatus) throw new Error(`invalid todo status: ${params.status}`);
				if (nextStatus === "in_progress") {
					const otherActive = activeTasks().find((task) => task.id !== id);
					if (otherActive) throw new Error(`todo #${otherActive.id} is already in_progress; complete it before starting #${id}`);
				}
				if (nextStatus === "completed" && affected.status !== "in_progress") {
					throw new Error(`todo #${id} must be in_progress before it can be completed; mark work active before ticking it off`);
				}
				if (typeof params.subject === "string") affected.subject = validateSubject(params.subject);
				if (typeof params.description === "string") affected.description = params.description;
				const wasActive = affected.status === "in_progress";
				if (nextStatus) affected.status = nextStatus;
				if (typeof params.activeForm === "string") affected.activeForm = params.activeForm;
				if (affected.status !== "in_progress") affected.activeForm = undefined;
				if (Array.isArray(params.blockedBy)) affected.blockedBy = normalizeBlockedBy(params.blockedBy);
				if (Array.isArray(params.addBlockedBy)) {
					affected.blockedBy = [...new Set([...(affected.blockedBy ?? []), ...(normalizeBlockedBy(params.addBlockedBy) ?? [])])];
				}
				if (Array.isArray(params.removeBlockedBy)) {
					const remove = new Set(normalizeBlockedBy(params.removeBlockedBy) ?? []);
					affected.blockedBy = (affected.blockedBy ?? []).filter((id) => !remove.has(id));
				}
				if (wasActive && affected.status === "completed") promoteNextPendingTask();
				enforceSingleActiveTask();
			} else if (action === "delete") {
				const id = Number(params.id);
				if (!Number.isInteger(id)) throw new Error("todo.delete requires id");
				affected = findTask(id);
				if (!affected) throw new Error(`todo #${id} not found`);
				const wasActive = affected.status === "in_progress";
				affected.status = "deleted";
				affected.activeForm = undefined;
				if (wasActive) promoteNextPendingTask();
				enforceSingleActiveTask();
			} else if (action === "get") {
				const id = Number(params.id);
				if (!Number.isInteger(id)) throw new Error("todo.get requires id");
				affected = findTask(id);
				if (!affected) throw new Error(`todo #${id} not found`);
			} else if (action === "list") {
				// no-op; details carry the snapshot
			} else if (action === "clear") {
				setState({ tasks: [], nextId: 1 });
				resetDisplayState();
			} else if (action === "finish" || action === "complete") {
				const id = Number(params.id);
				if (Number.isInteger(id)) {
					affected = findTask(id);
				} else {
					const active = activeTasks();
					if (active.length !== 1) throw new Error(`todo.complete without id requires exactly one in_progress task; found ${active.length}`);
					affected = active[0];
				}
				if (!affected) throw new Error("todo.complete target not found");
				if (affected.status !== "in_progress") throw new Error(`todo #${affected.id} must be in_progress before it can be completed; mark work active before ticking it off`);
				const wasActive = affected.status === "in_progress";
				affected.status = "completed";
				affected.activeForm = undefined;
				if (wasActive) promoteNextPendingTask();
				enforceSingleActiveTask();
			} else {
				throw new Error(`unknown todo action: ${params.action}`);
			}

			writeTodosFile();
			const snap = snapshot();
			const summary = action === "create_many"
				? `create_many: ${affectedMany.length} tasks`
				: action === "finish" || action === "complete"
					? summarize("complete" as TodoAction, affected)
					: summarize(action, affected);
			return {
				content: [{ type: "text" as const, text: renderStateSummary(action, summary) }],
				details: { action, params, tasks: snap.tasks, fridayTodoState: snap },
			};
		},
		renderCall(args, theme) {
			return {
				render: () => [theme.fg("dim", `todo ${renderActionSummary(args)}`)],
				invalidate: () => {},
			};
		},
		renderResult(_result, { isPartial }, theme) {
			return {
				render: () => [isPartial ? theme.fg("warning", "...") : theme.fg("dim", "✓")],
				invalidate: () => {},
			};
		},
	});

	pi.registerCommand("todos", {
		description: "Show Friday's built-in todo list",
		handler: async (_args, ctx) => {
			writeTodosFile();
			const lines = renderTodoLines().map(stripAnsi);
			ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No todos", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => replayFromBranch(ctx));
	pi.on("session_tree", async (_event, ctx) => replayFromBranch(ctx));
	pi.on("session_compact", async (_event, ctx) => replayFromBranch(ctx));
	pi.on("before_agent_start", async (_event, _ctx) => {
		clearCompletedPlanIfDone(true);
		writeTodosFile();
		const reminder = buildReminder();
		if (!reminder) return;
		return {
			message: {
				customType: "friday-todo-state",
				content: reminder,
				display: false,
			},
		};
	});
	pi.on("agent_start", async () => {
		agentRunning = true;
		writeTodosFile();
	});
	pi.on("agent_end", async () => {
		agentRunning = false;
		writeTodosFile();
	});
	pi.on("session_shutdown", async () => writeTodosFile(true));
}
