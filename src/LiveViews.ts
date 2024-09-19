import type { Extension } from "@codemirror/state";
import {
	StateEffect,
	StateField,
	EditorState,
	Compartment,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
	App,
	MarkdownView,
	Platform,
	TFile,
	Workspace,
	moment,
	type CachedMetadata,
} from "obsidian";
import ViewActions from "src/components/ViewActions.svelte";
import * as Y from "yjs";
import { Document } from "./Document";
import type { ConnectionState } from "./HasProvider";
import { LoginManager } from "./LoginManager";
import NetworkStatus from "./NetworkStatus";
import { SharedFolder, SharedFolders } from "./SharedFolder";
import { curryLog } from "./debug";
import { promiseWithTimeout } from "./promiseUtils";
import { Banner } from "./ui/Banner";
import { LiveEdit } from "./y-codemirror.next/LiveEditPlugin";
import {
	yRemoteSelections,
	yRemoteSelectionsTheme,
} from "./y-codemirror.next/RemoteSelections";
import { InvalidLinkPlugin } from "./markdownView/InvalidLinkExtension";
import * as Differ from "./differ/differencesView";

const BACKGROUND_CONNECTIONS = 3;

function iterateMarkdownViews(
	workspace: Workspace,
	fn: (leaf: MarkdownView) => void,
) {
	workspace.iterateAllLeaves((leaf) => {
		if (leaf.view instanceof MarkdownView) {
			fn(leaf.view);
		}
	});
}

function ViewsetsEqual(vs1: S3View[], vs2: S3View[]): boolean {
	if (vs1.length !== vs2.length) {
		return false;
	}

	for (let i = 0; i < vs1.length; i++) {
		if (vs1[i].view.file?.path !== vs2[i].view.file?.path) {
			return false;
		}
		if (vs1[i].document?.path !== vs2[i].document?.path) {
			return false;
		}
	}
	return true;
}

export interface S3View {
	view: MarkdownView;
	release: () => void;
	attach: () => Promise<S3View>;
	document: Document | null;
	destroy: () => void;
}

export class LoggedOutView implements S3View {
	view: MarkdownView;
	login: () => Promise<boolean>;
	banner?: Banner;
	document = null;

	private _parent: LiveViewManager;

	constructor(
		connectionManager: LiveViewManager,
		view: MarkdownView,
		login: () => Promise<boolean>,
	) {
		this._parent = connectionManager; // for debug
		this.view = view;
		this.login = login;
	}

	attach(): Promise<S3View> {
		this.banner = new Banner(
			this.view,
			"Login to enable Live edits",
			async () => {
				return await this.login();
			},
		);
		return Promise.resolve(this);
	}

	release() {
		this.banner?.destroy();
	}

	destroy() {
		this.release();
		this.banner = undefined;
		this.view = null as any;
	}
}

export function isLive(view: S3View): view is LiveView {
	return view instanceof LiveView;
}

export class LiveView implements S3View {
	view: MarkdownView;
	document: Document;
	shouldConnect: boolean;
	canConnect: boolean;

	private _viewActions?: ViewActions;
	private offConnectionStatusSubscription?: () => void;
	private _parent: LiveViewManager;
	private _banner?: Banner;

	constructor(
		connectionManager: LiveViewManager,
		view: MarkdownView,
		document: Document,
		shouldConnect = true,
		canConnect = true,
	) {
		this._parent = connectionManager; // for debug
		this.view = view;
		this.document = document;

		this.shouldConnect = shouldConnect;
		this.canConnect = canConnect;
		if (!connectionManager.networkStatus.online) {
			this.offlineBanner();
		}
	}

	toggleConnection() {
		this.shouldConnect = !this.shouldConnect;
		if (this.shouldConnect) {
			this.document.connect().then((connected) => {
				if (!connected) {
					// If we couldn't connect, ensure their next press tries again.
					this.shouldConnect = false;
				}
			});
		} else {
			this.document.disconnect();
		}
	}

	public get ytext(): Y.Text {
		return this.document.ytext;
	}

	mergeBanner(): () => void {
		this._banner = new Banner(
			this.view,
			"Merge conflict -- click to resolve",
			async () => {
				const diskBuffer = await this.document.diskBuffer();
				const stale = await this.document.checkStale();
				if (!stale) {
					return true;
				}
				this._parent.openDiffView({
					file1: this.document,
					file2: diskBuffer,
					showMergeOption: true,
					onResolve: async () => {
						this.document.clearDiskBuffer();
					},
				});
				return true;
			},
		);
		return () => {};
	}

	offlineBanner(): () => void {
		if (this.shouldConnect) {
			const banner = new Banner(
				this.view,
				"You're offline -- click to reconnect",
				async () => {
					this._parent.networkStatus.checkStatus();
					this.connect();
					return this._parent.networkStatus.online;
				},
			);
			this._parent.networkStatus.onceOnline(() => {
				this.connect();
				banner.destroy();
			});
		}
		return () => {};
	}

	setConnectionDot(): void {
		const viewActionsElement =
			this.view.containerEl.querySelector(".view-actions");
		if (viewActionsElement && viewActionsElement.firstChild) {
			if (!this._viewActions) {
				this.clearViewActions();
				if (this.offConnectionStatusSubscription) {
					this.offConnectionStatusSubscription();
				}
				this._viewActions = new ViewActions({
					target: viewActionsElement,
					anchor: viewActionsElement.firstChild as Element,
					props: {
						view: this,
						document: this.document,
						state: this.document.state,
					},
				});
				this.offConnectionStatusSubscription = this.document.subscribe(
					viewActionsElement,
					(state: ConnectionState) => {
						this._viewActions?.$set({
							view: this,
							document: this.document,
							state: state,
						});
					},
				);
			}
			this._viewActions.$set({
				view: this,
				document: this.document,
				state: this.document.state,
			});
		}
	}

	clearViewActions() {
		const viewActionsElement =
			this.view.containerEl.querySelector(".view-actions");
		if (viewActionsElement && viewActionsElement.firstChild) {
			const viewActions = this.view.containerEl.querySelectorAll(
				".system3-view-action",
			);
			if (viewActions.length > 0) {
				viewActions.forEach((viewAction) => {
					viewAction.remove();
				});
			}
		}
	}

	async checkStale() {
		const stale = await this.document.checkStale();
		if (stale && this.document._diskBuffer?.contents && this.document.text) {
			this.mergeBanner();
		} else {
			this._banner?.destroy();
			this._banner = undefined;
		}
		return stale;
	}

	_workaroundCM6StateFieldInitialization() {
		const editorView = (this.view.editor as any).cm as EditorView;
		const field = editorView.state.field(ConnectionManagerStateField, false);
		if (field === undefined) {
			this._parent.reconfigure(editorView);
		}
	}

	attach(): Promise<LiveView> {
		// can be called multiple times, whereas release is only ever called once
		this.setConnectionDot();
		this._workaroundCM6StateFieldInitialization();

		return new Promise((resolve) => {
			return this.document
				.whenReady()
				.then((doc) => {
					if (
						this.shouldConnect &&
						this.canConnect &&
						this._parent.networkStatus.online
					) {
						this.connect();
					}
					resolve(this);
				})
				.catch(() => {
					this.offlineBanner();
				});
		});
	}

	connect() {
		this.document.connect();
	}

	release() {
		// Called when a view is released from management
		this._viewActions?.$destroy();
		this._viewActions = undefined;
		this._banner?.destroy();
		this._banner = undefined;
		if (this.offConnectionStatusSubscription) {
			this.offConnectionStatusSubscription();
			this.offConnectionStatusSubscription = undefined;
		}
		this.document.disconnect();
	}

	_workaroundCM6MemoryLeak() {
		// CM6 memory leak
		// CM6 will hold references to state fields in config.dynamicSlots
		// for us this is a big problem because LiveViewManager has references
		// to basically everything.
		const editor = this.view.editor;
		const editorView = (editor as any).cm as EditorView;
		(editorView.state as any).config.dynamicSlots.length = 0;
	}

	destroy() {
		this.release();
		this.clearViewActions();
		this._workaroundCM6MemoryLeak();
		this._parent = null as any;
		this.view = null as any;
		this.document = null as any;
	}
}

export class LiveViewManager {
	workspace: Workspace;
	views: S3View[];
	private _activePromise?: Promise<boolean> | null;
	_compartment: Compartment;
	private loginManager: LoginManager;
	private offListeners: (() => void)[] = [];
	private folderListeners: Map<SharedFolder, () => void> = new Map();
	private metadataListeners: Map<
		TFile,
		(data: string, cache: CachedMetadata) => void
	>;
	sharedFolders: SharedFolders;
	extensions: Extension[];
	networkStatus: NetworkStatus;
	refreshQueue: (() => Promise<boolean>)[];
	log: (message: string, ...args: unknown[]) => void;
	warn: (message: string, ...args: unknown[]) => void;

	constructor(
		private app: App,
		sharedFolders: SharedFolders,
		loginManager: LoginManager,
		networkStatus: NetworkStatus,
	) {
		this.workspace = app.workspace;
		this.sharedFolders = sharedFolders;
		this.views = [];
		this.extensions = [];
		this._activePromise = null;
		this.loginManager = loginManager;
		this.networkStatus = networkStatus;
		this.refreshQueue = [];
		this._compartment = new Compartment();

		this.log = curryLog("[LiveViews]", "log");
		this.warn = curryLog("[LiveViews]", "warn");

		this.metadataListeners = new Map();
		const cb = (tfile: TFile, data: string, cache: CachedMetadata) => {
			const sub = this.metadataListeners.get(tfile);
			sub?.(data, cache);
		};

		const offRef = this.app.metadataCache.on("changed", cb);
		this.offListeners.push(() => {
			this.app.metadataCache.offref(offRef);
		});

		this.offListeners.push(
			this.loginManager.on(() => {
				this.refresh("[LoginManager]");
			}),
		);

		const folderSub = (folder: SharedFolder) => {
			if (!folder.ready) {
				folder
					.whenReady()
					.then(() => {
						this.refresh("[Shared Folder Ready]");
					})
					.catch((_) => {
						this.views.forEach((view) => {
							if (view.document?.sharedFolder === folder) {
								(view as LiveView).offlineBanner();
							}
						});
					});
			}

			return folder.docset.on(() => {
				this.refresh("[Docset]");
			});
		};

		this.offListeners.push(
			this.sharedFolders.on(() => {
				this.refresh("[Shared Folders]");
				this.folderListeners.forEach((off, folder) => {
					if (!this.sharedFolders.has(folder)) {
						off();
						this.folderListeners.delete(folder);
					}
				});
				this.sharedFolders.forEach((folder) => {
					if (!this.folderListeners.has(folder)) {
						this.folderListeners.set(folder, folderSub(folder));
					}
				});
			}),
		);
	}

	reconfigure(editorView: EditorView) {
		editorView.dispatch({
			effects: this._compartment.reconfigure([
				ConnectionManagerStateField.init(() => {
					return this;
				}),
			]),
		});
	}

	onMeta(tfile: TFile, cb: (data: string, cache: CachedMetadata) => void) {
		this.metadataListeners.set(tfile, cb);
	}

	openDiffView(state: Differ.ViewState) {
		Differ.openDiffView(this.workspace, state);
	}

	goOffline() {
		this.log("[System 3][Relay][Live Views] going offline");
		this.views.forEach((view) => view.document?.disconnect());
		this.refresh("[NetworkStatus]");
	}

	goOnline() {
		this.log("[System 3][Relay][Live Views] going online");
		this.refresh("[NetworkStatus]");
		this.sharedFolders.items().forEach((folder: SharedFolder) => {
			folder.connect();
		});
		this.viewsAttachedWithConnectionPool(this.views);
	}

	docIsOpen(doc: Document): boolean {
		return this.views.some((view) => view.document === doc);
	}

	private releaseViews(views: S3View[]) {
		views.forEach((view) => {
			view.release();
		});
	}

	private findFolders(): SharedFolder[] {
		const folders: Set<SharedFolder> = new Set<SharedFolder>();
		iterateMarkdownViews(this.workspace, (markdownView) => {
			// Check if the view is displaying a file
			const viewFilePath = markdownView.file?.path;
			if (!viewFilePath) {
				return;
			}
			const folder = this.sharedFolders.lookup(viewFilePath);
			if (folder) {
				folders.add(folder);
			}
		});
		if ([...folders].length == 0) {
			return [];
		}
		return [...folders];
	}

	private async foldersReady(): Promise<SharedFolder[]> {
		const folders: Set<SharedFolder> = new Set<SharedFolder>();
		iterateMarkdownViews(this.workspace, (markdownView) => {
			// Check if the view is displaying a file
			const viewFilePath = markdownView.file?.path;
			if (!viewFilePath) {
				return;
			}
			const folder = this.sharedFolders.lookup(viewFilePath);
			if (folder) {
				folders.add(folder);
			}
		});
		if ([...folders].length == 0) {
			return [];
		}

		const readyFolders = [...folders].map((folder) => folder.whenReady());
		return Promise.all(readyFolders);
	}

	private getViews(): S3View[] {
		const views: S3View[] = [];
		iterateMarkdownViews(this.workspace, (markdownView) => {
			const viewFilePath = markdownView.file?.path;
			if (!viewFilePath) {
				return;
			}
			const folder = this.sharedFolders.lookup(viewFilePath);
			if (folder) {
				if (!this.loginManager.loggedIn) {
					const view = new LoggedOutView(this, markdownView, () => {
						return this.loginManager.openLoginPage();
					});
					views.push(view);
				} else {
					const doc = folder.getFile(viewFilePath, true, true, true);
					const view = new LiveView(this, markdownView, doc);
					views.push(view);
				}
			}
		});
		return views;
	}

	findView(cmEditor: EditorView): S3View | undefined {
		return this.views.find((view) => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const editor = view.view.editor as any;
			const cm = editor.cm as EditorView;
			return cm === cmEditor;
		});
	}

	private async viewsReady(views: S3View[]): Promise<LiveView[]> {
		// XXX yeesh
		return await Promise.all(
			views
				.filter((view) => view instanceof LiveView)
				.map(async (view) =>
					(view as LiveView).document.whenReady().then((_) => view as LiveView),
				),
		);
	}

	private async viewsAttachedWithConnectionPool(
		views: S3View[],
		backgroundConnections: number = BACKGROUND_CONNECTIONS,
	): Promise<S3View[]> {
		const activeView =
			this.workspace.getActiveViewOfType<MarkdownView>(MarkdownView);

		let attemptedConnections = 0;

		const viewHistory = views.sort(
			(a, b) =>
				(b.view.leaf as any).activeTime - (a.view.leaf as any).activeTime,
		);
		for (const view of viewHistory) {
			if (view instanceof LiveView) {
				if (view.view === activeView) {
					view.canConnect = true;
				} else {
					view.canConnect = attemptedConnections < backgroundConnections;
					attemptedConnections++;
				}
			}
		}

		if (attemptedConnections > backgroundConnections) {
			this.warn(
				`[System 3][Relay][Live Views] connection pool (max ${backgroundConnections}): rejected connections for ${
					attemptedConnections - backgroundConnections
				} views`,
			);
		}

		return this.viewsAttached(views);
	}

	private async viewsAttached(views: S3View[]): Promise<S3View[]> {
		return await Promise.all(
			views.map(async (view) => {
				return view.attach();
			}),
		);
	}

	private deduplicate(views: S3View[]): [S3View[], S3View[]] {
		const stale: S3View[] = [];
		const matching: S3View[] = [];
		this.views.forEach((oldView) => {
			const found = views.find((newView) => {
				if (
					oldView.document == newView.document &&
					oldView.view == newView.view
				) {
					return true;
				}
			});
			if (found) {
				matching.push(oldView);
				views.remove(found);
			} else {
				stale.push(oldView);
			}
		});
		views.forEach((view) => {
			matching.push(view);
		});
		return [matching, stale];
	}

	async _refreshViews(
		context: string,
		queuedAt: moment.Moment,
	): Promise<boolean> {
		const ctx = `[LiveViews][${context}]`;
		const log = curryLog(ctx, "warn");
		const logViews = (message: string, views: S3View[]) => {
			log(
				message,
				views.map((view) => ({
					type: view.constructor.name,
					file: view.document?.path,
				})),
			);
		};
		log("Refresh");

		await this.foldersReady();

		let views: S3View[] = [];
		try {
			views = this.getViews();
		} catch (e) {
			this.warn("[System 3][Relay][Live Views] error getting views", e);
			return false;
		}
		const activeDocumentFolders = this.findFolders();
		if (activeDocumentFolders.length === 0 && views.length === 0) {
			if (this.extensions.length !== 0) {
				log("Unexpected plugins loaded.");
				this.wipe();
			}
			logViews("Releasing Views", this.views);
			this.releaseViews(this.views);
			this.views = [];
			return true; // no live views open
		}

		if (this.loginManager.loggedIn && this.networkStatus.online) {
			activeDocumentFolders.forEach((folder) => {
				folder.connect();
			});
		} else {
			this.sharedFolders.forEach((folder) => {
				folder.disconnect();
			});
		}

		const [matching, stale] = this.deduplicate(views);
		logViews("Releasing Views", stale);
		this.releaseViews(stale);
		if (stale.length === 0 && ViewsetsEqual(matching, this.views)) {
			// We can assume all views are ready.
			const attachedViews = await this.viewsAttachedWithConnectionPool(
				this.views,
			);
			logViews("Attached Views", attachedViews);
		} else {
			const readyViews = await this.viewsReady(matching);
			logViews("Ready Views", readyViews);
			const attachedViews =
				await this.viewsAttachedWithConnectionPool(readyViews);
			logViews("Attached Views", attachedViews);
			this.views = matching;
		}
		log("loading plugins");
		this.load();
		const now = moment.utc();
		log(`refresh completed in ${now.diff(queuedAt)}ms`, ctx);
		return true;
	}

	async refresh(context: string, timeout = 3000) {
		const log = curryLog(context, "warn");
		const queuedAt = moment.utc();
		this.refreshQueue.push(() => {
			return this._refreshViews(context, queuedAt);
		});
		if (this._activePromise !== null) {
			return false;
		}
		while (this.refreshQueue.length > 0) {
			if (this.refreshQueue.length > 2) {
				log("refreshQueue size:", this.refreshQueue.length);
				this.refreshQueue.slice(-2);
			}
			if (Platform.isIosApp) {
				this._activePromise = this.refreshQueue.pop()!().finally(() => {
					this._activePromise = null;
				});
				await this._activePromise;
			} else {
				this._activePromise = promiseWithTimeout<boolean>(
					this.refreshQueue.pop()!(),
					timeout,
				)
					.catch((e) => {
						this.warn(
							`[System 3][Relay][Live Views] refresh views timed out... timeout=${timeout}`,
							e,
						);
						this._activePromise = null;
						return false;
					})
					.finally(() => {
						this._activePromise = null;
					});
				await this._activePromise;
			}
		}
		return true;
	}

	wipe() {
		this.extensions.length = 0;
		this.workspace.updateOptions();
	}

	load() {
		this.wipe();
		if (this.views.length > 0) {
			this.extensions.push([
				this._compartment.of(
					ConnectionManagerStateField.init(() => {
						return this;
					}),
				),
				LiveEdit,
				yRemoteSelectionsTheme,
				yRemoteSelections,
				InvalidLinkPlugin,
			]);
			this.workspace.updateOptions();
		}
	}

	public destroy() {
		this.releaseViews(this.views);
		this.offListeners.forEach((off) => off());
		this.offListeners.length = 0;
		this.metadataListeners.clear();
		this.metadataListeners = null as any;
		this.folderListeners.forEach((off) => off());
		this.folderListeners.clear();
		this.folderListeners = null as any;
		this.views.forEach((view) => view.destroy());
		this.views = [];
		this.wipe();
		this.sharedFolders = null as any;
		this.refreshQueue = null as any;
		this.networkStatus = null as any;
		this._activePromise = null as any;
	}
}

export const ConnectionManagerStateField = StateField.define<
	LiveViewManager | undefined
>({
	create(state: EditorState) {
		return undefined;
	},
	update(currentManager, transaction) {
		return currentManager;
	},
});
