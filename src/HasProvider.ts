"use strict";
import { Doc } from "yjs";
import { YSweetProvider } from "@y-sweet/client";
import { User } from "./User";
import { curryLog } from "./debug";
import { LoginManager } from "./LoginManager";
import { LiveTokenStore } from "./LiveTokenStore";
import type { ClientToken } from "./y-sweet";
import { promiseWithTimeout } from "./promiseUtils";
import { S3RemoteDocument, S3RN, type S3RNType, S3RemoteFolder } from "./S3RN";
import { Platform } from "obsidian";

export type ConnectionStatus =
	| "connected"
	| "connecting"
	| "disconnected"
	| "unknown";
export type ConnectionIntent = "connected" | "disconnected";

enum readyState {
	CONNECTING = 0,
	OPEN = 1,
	CLOSING = 2,
	CLOSED = 3,
}

const readyStateMap = {
	3: "disconnected",
	2: "disconnected",
	1: "connected",
	0: "connecting",
} as const;

export interface ConnectionState {
	status: ConnectionStatus;
	intent: ConnectionIntent;
}

export interface Subscription {
	on: () => void;
	off: () => void;
}

function s3rnToYsweetDocId(entity: S3RNType): string {
	// YSweet has various restrictions on the allowed characterset
	if (entity instanceof S3RemoteDocument) {
		return entity.relayId + "-" + entity.documentId;
	}
	if (entity instanceof S3RemoteFolder) {
		return entity.relayId + "-" + entity.folderId;
	}
	return "-";
}

function makeProvider(
	clientToken: ClientToken,
	s3rn: S3RNType,
	ydoc: Doc,
	user?: User
): YSweetProvider {
	const params = {
		token: clientToken.token,
	};
	const ysweetDocId = s3rnToYsweetDocId(s3rn);
	const provider = new YSweetProvider(clientToken.url, ysweetDocId, ydoc, {
		connect: false,
		params: params,
		disableBc: true,
	});

	if (user) {
		provider.awareness.setLocalStateField("user", {
			name: user.name,
			color: user.color.color,
			colorLight: user.color.light,
		});
	}
	return provider;
}

type Listener = (state: ConnectionState) => void;

export class HasProvider {
	_provider: YSweetProvider;
	_s3rn: S3RNType;
	path?: string;
	ydoc: Doc;
	loginManager: LoginManager;
	tokenStore: LiveTokenStore;
	clientToken: ClientToken;
	private _offConnectionError: () => void;
	private _offState: () => void;
	PROVIDER_MAX_ERRORS = 3;
	log = curryLog("[HasProvider]");
	listeners: Map<unknown, Listener>;

	constructor(
		s3rn: S3RNType,
		tokenStore: LiveTokenStore,
		loginManager: LoginManager
	) {
		this._s3rn = s3rn;
		this.listeners = new Map<unknown, Listener>();
		this.loginManager = loginManager;
		this.ydoc = new Doc();
		this.tokenStore = tokenStore;
		this.clientToken =
			this.tokenStore.getTokenSync(S3RN.encode(this.s3rn)) ||
			({ token: "", url: "", expiryTime: 0 } as ClientToken);
		const user = this.loginManager?.user;

		this._provider = makeProvider(
			this.clientToken,
			this.s3rn,
			this.ydoc,
			user
		);

		const connectionErrorSub = this.providerConnectionErrorSubscription(
			(event) => {
				this.log(`[${this.path}] disconnection event`, event);
				const shouldConnect =
					this._provider.url &&
					this._provider.shouldConnect &&
					this._provider.wsUnsuccessfulReconnects <
						this.PROVIDER_MAX_ERRORS;
				this.disconnect();
				if (shouldConnect) {
					this.connect();
				}
			}
		);
		connectionErrorSub.on();
		this._offConnectionError = connectionErrorSub.off;

		const stateSub = this.providerStateSubscription(
			(state: ConnectionState) => {
				this.notifyListeners();
			}
		);
		stateSub.on();
		this._offState = stateSub.off;
	}

	public get s3rn(): S3RNType {
		return this._s3rn;
	}

	public set s3rn(value: S3RNType) {
		this._s3rn = value;
		this.refreshProvider(this.clientToken);
	}

	notifyListeners() {
		console.debug("[Provider State]", this.path, this.state);
		this.listeners.forEach((listener) => {
			listener(this.state);
		});
	}

	subscribe(el: unknown, listener: Listener): () => void {
		this.listeners.set(el, listener);
		return () => {
			this.unsubscribe(el);
		};
	}

	unsubscribe(el: unknown) {
		this.listeners.delete(el);
	}

	async getProviderToken(): Promise<ClientToken> {
		this.log("get provider token");

		const tokenPromise = this.tokenStore.getToken(
			S3RN.encode(this.s3rn),
			this.path || "unknown",
			this.refreshProvider.bind(this)
		);
		if (Platform.isIosApp) {
			return tokenPromise;
		}
		const timeoutPromise = promiseWithTimeout<ClientToken>(
			tokenPromise,
			10000
		);
		return timeoutPromise;
	}

	providerActive() {
		if (this.clientToken) {
			const tokenIsSet = this._provider.url == this.clientToken.url;
			const expired = Date.now() > (this.clientToken?.expiryTime || 0);
			return tokenIsSet && !expired;
		}
		return false;
	}

	refreshProvider(clientToken: ClientToken) {
		// updates the provider when a new token is received
		this.clientToken = clientToken;
		const tempProvider = makeProvider(clientToken, this.s3rn, new Doc());
		const newUrl = tempProvider.url;

		if (!this._provider) {
			throw new Error("missing provider!");
		} else if (this._provider.url !== newUrl) {
			this._provider.url = newUrl;
			this._provider.wsUnsuccessfulReconnects = 0;
			this.log(
				`Token Refreshed: setting new provider url, ${this._provider.url}`
			);
			this._provider.ws?.close();
		}
	}

	public get connected(): boolean {
		return this.state.status === "connected";
	}

	connect(): Promise<boolean> {
		if (this.connected) {
			return Promise.resolve(true);
		}
		return this.getProviderToken()
			.then((clientToken) => {
				this.refreshProvider(clientToken); // XXX is this still needed?
				this._provider.connect();
				this.notifyListeners();
				return true;
			})
			.catch((e) => {
				return false;
			});
	}

	public get state(): ConnectionState {
		return {
			status: readyStateMap[
				(this._provider.ws?.readyState ||
					readyState.CLOSED) as readyState
			],
			intent: this._provider.shouldConnect ? "connected" : "disconnected",
		};
	}

	public get synced(): boolean {
		return this._provider.synced;
	}

	disconnect() {
		// this is cursed -- I should consider forking the ysweet provider.
		this._provider.shouldConnect = false;
		this._provider.ws?.close();
		this._provider.ws = null;
		this.notifyListeners();
	}

	public withActiveProvider<T extends HasProvider>(this: T): Promise<T> {
		if (this.providerActive()) {
			return new Promise((resolve) => {
				resolve(this);
			});
		}
		return this.getProviderToken().then((clientToken) => {
			return this;
		});
	}

	onceConnected(): Promise<void> {
		// XXX memory leak of subscriptions...
		return new Promise((resolve) => {
			const resolveOnConnect = (state: ConnectionState) => {
				if (state.status === "connected") {
					resolve();
				}
			};
			this._provider.on("status", resolveOnConnect);
		});
	}

	onceProviderSynced(): Promise<void> {
		if (this._provider?.synced) {
			return new Promise((resolve) => {
				resolve();
			});
		}
		return new Promise((resolve) => {
			this._provider.once("synced", resolve);
		});
	}

	private _injectIntent(
		f: (state: ConnectionState) => void
	): (state: ConnectionState) => void {
		const inner = (state: ConnectionState) => {
			const intent = this._provider.shouldConnect
				? "connected"
				: "disconnected";
			f({ status: state.status, intent: intent });
		};
		return inner;
	}

	private providerConnectionErrorSubscription(
		f: (event: Event) => void
	): Subscription {
		const on = () => {
			this._provider.on("connection-error", f);
		};
		const off = () => {
			this._provider.off("connection-error", f);
		};
		return { on, off } as Subscription;
	}

	protected providerStateSubscription(
		f: (state: ConnectionState) => void
	): Subscription {
		const on = () => {
			this._provider.on("status", this._injectIntent(f));
		};
		const off = () => {
			this._provider.off("status", this._injectIntent(f));
		};
		return { on, off } as Subscription;
	}

	destroy() {
		if (this._offConnectionError) {
			this._offConnectionError();
		}
		if (this._offState) {
			this._offState();
		}
		if (this._provider) {
			this._provider.disconnect();
			this._provider.destroy();
		}
		this.listeners.clear();
	}
}
