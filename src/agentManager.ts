import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import type { AgentState, PersistedAgent } from './types.js';
import { cancelWaitingTimer, cancelPermissionTimer } from './timerManager.js';
import { startFileWatching, ensureCopilotSessionScan } from './fileWatcher.js';
import { JSONL_POLL_INTERVAL_MS, AGENT_NAME_PREFIX, WORKSPACE_KEY_AGENTS, WORKSPACE_KEY_AGENT_SEATS } from './constants.js';
import { migrateAndLoadLayout } from './layoutPersistence.js';

/**
 * Find the VS Code workspaceStorage chatSessions directory for the current workspace.
 * VS Code hashes the workspace URI to produce the storage folder name.
 * We scan all workspaceStorage entries until we find one whose workspace.json matches.
 */
export function getCopilotSessionsDir(cwd?: string): string | null {
	const workspacePath = cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspacePath) return null;

	const storageRoot = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage');

	// Also try Linux / Windows paths
	const altStorageRoots = [
		path.join(os.homedir(), '.config', 'Code', 'User', 'workspaceStorage'), // Linux
		path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage'), // Windows
	];

	const allRoots = [storageRoot, ...altStorageRoots];

	for (const root of allRoots) {
		if (!fs.existsSync(root)) continue;
		try {
			const entries = fs.readdirSync(root);
			for (const entry of entries) {
				const wsJsonPath = path.join(root, entry, 'workspace.json');
				if (!fs.existsSync(wsJsonPath)) continue;
				try {
					const wsJson = JSON.parse(fs.readFileSync(wsJsonPath, 'utf-8')) as { folder?: string };
					// The folder field is a file URI like 'file:///path/to/workspace'
					const folderUri = wsJson.folder;
					if (!folderUri) continue;
					const decoded = decodeURIComponent(folderUri.replace(/^file:\/\//, ''));
					if (decoded === workspacePath || decoded === workspacePath.replace(/\\/g, '/')) {
						const sessionsDir = path.join(root, entry, 'chatSessions');
						console.log(`[Pixel Agents] Found Copilot sessions dir: ${sessionsDir}`);
						return sessionsDir;
					}
				} catch { /* malformed workspace.json */ }
			}
		} catch { /* can't read storageRoot */ }
	}

	console.log('[Pixel Agents] Could not find Copilot sessions dir for workspace:', workspacePath);
	return null;
}

export async function openCopilotChat(
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	knownSessionFiles: Set<string>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	sessionPollTimers: Map<number, ReturnType<typeof setInterval>>,
	projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
	folderPath?: string,
): Promise<void> {
	// Open the GitHub Copilot Chat panel
	await vscode.commands.executeCommand('workbench.action.chat.open');

	const sessionsDir = getCopilotSessionsDir(folderPath);
	if (!sessionsDir) {
		console.log('[Pixel Agents] No Copilot sessions dir found');
		return;
	}

	// Ensure the chatSessions directory exists
	if (!fs.existsSync(sessionsDir)) {
		try { fs.mkdirSync(sessionsDir, { recursive: true }); } catch { /* ignore */ }
	}

	// Start scanning for new session files
	ensureCopilotSessionScan(
		sessionsDir, knownSessionFiles, projectScanTimerRef,
		nextAgentIdRef, agents, fileWatchers, pollingTimers,
		waitingTimers, permissionTimers, webview, persistAgents,
	);
}

export function removeAgent(
	agentId: number,
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	sessionPollTimers: Map<number, ReturnType<typeof setInterval>>,
	persistAgents: () => void,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	// Stop session poll timer
	const spTimer = sessionPollTimers.get(agentId);
	if (spTimer) { clearInterval(spTimer); }
	sessionPollTimers.delete(agentId);

	// Stop file watching
	fileWatchers.get(agentId)?.close();
	fileWatchers.delete(agentId);
	const pt = pollingTimers.get(agentId);
	if (pt) { clearInterval(pt); }
	pollingTimers.delete(agentId);
	try { fs.unwatchFile(agent.sessionFile); } catch { /* ignore */ }

	// Cancel timers
	cancelWaitingTimer(agentId, waitingTimers);
	cancelPermissionTimer(agentId, permissionTimers);

	// Remove from maps
	agents.delete(agentId);
	persistAgents();
}

export function persistAgents(
	agents: Map<number, AgentState>,
	context: vscode.ExtensionContext,
): void {
	const persisted: PersistedAgent[] = [];
	for (const agent of agents.values()) {
		persisted.push({
			id: agent.id,
			sessionFile: agent.sessionFile,
			sessionsDir: agent.sessionsDir,
			folderName: agent.folderName,
		});
	}
	context.workspaceState.update(WORKSPACE_KEY_AGENTS, persisted);
}

export function restoreAgents(
	context: vscode.ExtensionContext,
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	knownSessionFiles: Set<string>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	sessionPollTimers: Map<number, ReturnType<typeof setInterval>>,
	projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
	webview: vscode.Webview | undefined,
	doPersist: () => void,
): void {
	const persisted = context.workspaceState.get<PersistedAgent[]>(WORKSPACE_KEY_AGENTS, []);
	if (persisted.length === 0) return;

	let maxId = 0;
	let restoredSessionsDir: string | null = null;

	for (const p of persisted) {
		const agent: AgentState = {
			id: p.id,
			sessionFile: p.sessionFile,
			sessionsDir: p.sessionsDir,
			lastRequestCount: 0,
			lastResponseChunkCount: 0,
			activeToolIds: new Set(),
			activeToolStatuses: new Map(),
			activeToolNames: new Map(),
			activeSubagentToolIds: new Map(),
			activeSubagentToolNames: new Map(),
			isWaiting: false,
			permissionSent: false,
			hadToolsInTurn: false,
			folderName: p.folderName,
		};

		agents.set(p.id, agent);
		knownSessionFiles.add(p.sessionFile);
		console.log(`[Pixel Agents] Restored agent ${p.id} → ${path.basename(p.sessionFile)}`);

		if (p.id > maxId) maxId = p.id;
		restoredSessionsDir = p.sessionsDir;

		// Start file watching if session file exists
		try {
			if (fs.existsSync(p.sessionFile)) {
				startFileWatching(p.id, p.sessionFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
			} else {
				// Poll for the file to appear
				const pollTimer = setInterval(() => {
					try {
						if (fs.existsSync(agent.sessionFile)) {
							console.log(`[Pixel Agents] Restored agent ${p.id}: found session file`);
							clearInterval(pollTimer);
							sessionPollTimers.delete(p.id);
							startFileWatching(p.id, agent.sessionFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
						}
					} catch { /* file may not exist yet */ }
				}, JSONL_POLL_INTERVAL_MS);
				sessionPollTimers.set(p.id, pollTimer);
			}
		} catch { /* ignore errors during restore */ }
	}

	// Advance counters past restored IDs
	if (maxId >= nextAgentIdRef.current) {
		nextAgentIdRef.current = maxId + 1;
	}

	doPersist();

	// Start session scan for new files
	if (restoredSessionsDir) {
		ensureCopilotSessionScan(
			restoredSessionsDir, knownSessionFiles, projectScanTimerRef,
			nextAgentIdRef, agents, fileWatchers, pollingTimers,
			waitingTimers, permissionTimers, webview, doPersist,
		);
	}
}

export function sendExistingAgents(
	agents: Map<number, AgentState>,
	context: vscode.ExtensionContext,
	webview: vscode.Webview | undefined,
): void {
	if (!webview) return;
	const agentIds: number[] = [];
	for (const id of agents.keys()) {
		agentIds.push(id);
	}
	agentIds.sort((a, b) => a - b);

	// Include persisted palette/seatId from separate key
	const agentMeta = context.workspaceState.get<Record<string, { palette?: number; seatId?: string }>>(WORKSPACE_KEY_AGENT_SEATS, {});

	// Include folderName per agent
	const folderNames: Record<number, string> = {};
	for (const [id, agent] of agents) {
		if (agent.folderName) {
			folderNames[id] = agent.folderName;
		}
	}
	console.log(`[Pixel Agents] sendExistingAgents: agents=${JSON.stringify(agentIds)}, meta=${JSON.stringify(agentMeta)}`);

	webview.postMessage({
		type: 'existingAgents',
		agents: agentIds,
		agentMeta,
		folderNames,
	});

	sendCurrentAgentStatuses(agents, webview);
}

export function sendCurrentAgentStatuses(
	agents: Map<number, AgentState>,
	webview: vscode.Webview | undefined,
): void {
	if (!webview) return;
	for (const [agentId, agent] of agents) {
		// Re-send active tools
		for (const [toolId, status] of agent.activeToolStatuses) {
			webview.postMessage({
				type: 'agentToolStart',
				id: agentId,
				toolId,
				status,
			});
		}
		// Re-send waiting status
		if (agent.isWaiting) {
			webview.postMessage({
				type: 'agentStatus',
				id: agentId,
				status: 'waiting',
			});
		}
	}
}

export function sendLayout(
	context: vscode.ExtensionContext,
	webview: vscode.Webview | undefined,
	defaultLayout?: Record<string, unknown> | null,
): void {
	if (!webview) return;
	const layout = migrateAndLoadLayout(context, defaultLayout);
	webview.postMessage({
		type: 'layoutLoaded',
		layout,
	});
}
