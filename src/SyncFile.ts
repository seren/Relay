"use strict";
import {
	S3File,
	S3RemoteFile,
	S3Document,
	S3Folder,
	type S3RNType,
} from "./S3RN";
import { SharedFolder } from "./SharedFolder";
import { curryLog } from "./debug";
import { TFile, type Vault, type TFolder, type FileStats } from "obsidian";
import type { Unsubscriber } from "./observable/Observable";
import type { RelayManager } from "./RelayManager";
import { uuidv4 } from "lib0/random";

export interface IFile {
	guid: string;
	path: string;
	move: (newPath: string) => void;
	connect: () => void;
	disconnect: () => void;
	destroy: () => void;
}

async function generateHash(content: ArrayBuffer): Promise<string> {
	const hashBuffer = await crypto.subtle.digest("SHA-256", content);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class SyncFile implements TFile, IFile {
	s3rn: S3RNType;
	private _parent: SharedFolder;
	_tfile: TFile | null = null;
	_filehash: string | undefined;
	name: string;
	extension: string;
	synctime: number;
	basename: string;
	vault: Vault;
	ready: boolean = false;
	connected: boolean = true;
	offFileInfo: Unsubscriber = () => {};
	offFolderStatusListener: Unsubscriber;

	debug!: (message?: any, ...optionalParams: any[]) => void;
	log!: (message?: any, ...optionalParams: any[]) => void;
	warn!: (message?: any, ...optionalParams: any[]) => void;
	error!: (message?: any, ...optionalParams: any[]) => void;

	setLoggers(context: string) {
		this.debug = curryLog(context, "debug");
		this.log = curryLog(context, "log");
		this.warn = curryLog(context, "warn");
		this.error = curryLog(context, "error");
	}

	constructor(
		public path: string,
		hashOrFile: string | TFile | undefined,
		public guid: string,
		private relayManager: RelayManager,
		parent: SharedFolder,
	) {
		if (hashOrFile instanceof TFile) {
			this._tfile = hashOrFile;
		} else {
			this._filehash = hashOrFile;
		}
		this.s3rn = parent.relayId
			? new S3RemoteFile(parent.relayId, parent.guid, guid)
			: new S3File(parent.guid, guid);
		this._parent = parent;
		this.name = this.path.split("/").pop() || "";
		this.extension = this.name.split(".").pop() || "";
		this.basename = this.name.replace(`.${this.extension}`, "");
		this.vault = this._parent.vault;
		const tfile = this.vault.getAbstractFileByPath(
			this.sharedFolder.getPath(path),
		);
		if (tfile instanceof TFile) {
			this._tfile = tfile;
		}
		this.synctime = this._tfile?.stat.mtime || 0;
		this.setLoggers(`[SharedFile](${this.path})`);
		this.offFolderStatusListener = this._parent.subscribe(
			this.path,
			(state) => {
				if (state.intent === "disconnected") {
					this.disconnect();
				}
			},
		);
		this.log("created");
	}

	static fromTFile(
		relayManager: RelayManager,
		sharedFolder: SharedFolder,
		tfile: TFile,
	) {
		return new SyncFile(
			sharedFolder.getVirtualPath(tfile.path),
			tfile,
			uuidv4(),
			relayManager,
			sharedFolder,
		);
	}

	disconnect() {
		this.connected = false;
	}

	move(newPath: string) {
		if (newPath === this.path) {
			return;
		}
		this.warn("setting new path", newPath);
		this.path = newPath;
		this.name = newPath.split("/").pop() || "";
		this.extension = this.name.split(".").pop() || "";
		this.basename = this.name.replace(`.${this.extension}`, "");
		this.setLoggers(`[SharedFile](${this.path})`);
		this.updateStats();
	}

	public get lastModified() {
		return this.stat.mtime;
		//return Math.max(this.stat.mtime, this.stat.ctime);
	}

	public get shouldPull() {
		return (this.sharedFolder.synctimes.get(this.guid) || 0) > this.synctime;
	}

	public get shouldPush() {
		const serverOutOfDate =
			(this.sharedFolder.synctimes.get(this.guid) || 0) < this.synctime;
		const serverHasContent = !!this.getRemote();
		this.warn(
			"should push?",
			this.sharedFolder.synctimes.get(this.guid) || 0,
			this.synctime,
			serverOutOfDate,
		);
		return serverOutOfDate || !serverHasContent;
	}

	public get serverHash() {
		return this.sharedFolder.hashes.get(this.guid);
	}

	public async getRemote() {
		if (!this.serverHash) {
			return undefined;
		}
		return this.sharedFolder.cas.getByHash(this.serverHash);
	}

	public async push(): Promise<string> {
		const fileInfo = await this.getRemote();
		this.warn("push");
		await this.updateStats();
		const content = await this.vault.readBinary(this.tfile);
		const hash = await generateHash(content);
		if (fileInfo?.synchash !== hash) {
			try {
				await this.sharedFolder.cas.writeFile(
					{
						guid: fileInfo ? fileInfo.guid : uuidv4(),
						name: this.name,
						synchash: hash,
						ctime: this.stat.ctime,
						mtime: this.stat.mtime,
						parent: null,
						is_directory: false,
						synctime: Date.now(),
					},
					content,
				);
			} catch (e) {
				// ignore duplicates
				this.warn("push error", e);
			}
		}
		this.synctime = Date.now();
		//} else {
		//	this.warn("content already on server", byHash);
		//}
		if (this.sharedFolder.hashes.get(this.guid) !== hash) {
			this.warn("updating hashes map", hash);
			this.sharedFolder.ydoc.transact(() => {
				this.sharedFolder.hashes.set(this.guid, hash);
				this.sharedFolder.synctimes.set(this.guid, this.synctime);
			});
		}
		return hash;
	}

	public async pull() {
		if (!this.serverHash) {
			throw new Error(`${this.path} no server hash for item`);
		}
		this.sharedFolder.cas.getByHash(this.serverHash);
		const fileInfo = await this.getRemote();
		if (!fileInfo) {
			throw new Error(
				`${this.path} (${this.serverHash}) item missing from server`,
			);
		}
		this.warn("pull");
		const content = await this.sharedFolder.cas.readFile(fileInfo.id);
		await this.vault.adapter.writeBinary(
			this.sharedFolder.getPath(this.path),
			content,
		);
		this._filehash = await generateHash(content);
		this._tfile = this.vault.getAbstractFileByPath(
			this.sharedFolder.getPath(this.path),
		) as TFile;
	}

	public get isStale() {
		const hash = this._filehash;
		const serverHash = this.sharedFolder.hashes.get(this.guid);
		this.log("hash state ", hash, serverHash);
		return hash !== serverHash;
	}

	async sync() {
		this.warn("running sync");
		if (!this.connected) {
			return;
		}
		if (!this._tfile) {
			await this.pull();
			return;
		}
		await this.getHash(true);
		if (this.isStale && this.shouldPull) {
			await this.pull();
		} else {
			await this.push();
		}
		//const fileInfo = this.relayManager.fileInfo.find(
		//	(fileInfo) => fileInfo.synchash === serverHash,
		//);
		//if (
		//	!fileInfo ||
		//		fileInfo.synctime < Math.max(this.stat.ctime, this.stat.mtime))
		//) {
		//	this.warn("gotta write");
		//	const content = await this.vault.readBinary(this.tfile);
		//	this.sharedFolder.cas.writeFile(
		//		{
		//			guid: fileInfo ? fileInfo.guid : uuidv4(),
		//			name: this.name,
		//			synchash: hash,
		//			ctime: this.stat.ctime,
		//			mtime: this.stat.mtime,
		//			parent: null,
		//			is_directory: false,
		//			synctime: Date.now(),
		//		},
		//		content,
		//	);
		//  this.sharedFolder.hashes.set(this.guid, hash);
		//} else if (fileInfo && serverHash !== hash) {
		//	this.warn("gotta read from server");
		//	const content = await this.sharedFolder.cas.readFile(fileInfo.id);
		//	await this.vault.adapter.writeBinary(
		//		this.sharedFolder.getPath(this.path),
		//		content,
		//	);
		//} else if (serverHash === hash) {
		//	this.warn("happy synced");
		//} else {
		//	this.warn("mystery");
		//}
	}

	public async getHash(compute = false): Promise<string> {
		if (this._filehash === undefined || compute) {
			await this.updateStats();
		}
		return this._filehash as string;
	}

	public get tfile(): TFile {
		const abstractFile = this.vault.getAbstractFileByPath(
			this.sharedFolder.getPath(this.path),
		);
		if (abstractFile instanceof TFile) {
			return abstractFile;
		}
		throw new Error("TFile API used before file existed");
	}

	public get stat(): FileStats {
		return this.tfile.stat;
	}

	public get parent(): TFolder | null {
		return this.tfile?.parent || null;
	}

	public get sharedFolder(): SharedFolder {
		return this._parent;
	}

	async connect(): Promise<boolean> {
		if (this.sharedFolder.s3rn instanceof S3Folder) {
			// Local only
			return false;
		} else if (this.s3rn instanceof S3Document) {
			// convert to remote document
			if (this.sharedFolder.relayId) {
				this.s3rn = new S3RemoteFile(
					this.sharedFolder.relayId,
					this.sharedFolder.guid,
					this.guid,
				);
			} else {
				this.s3rn = new S3File(this.sharedFolder.guid, this.guid);
			}
		}
		return (
			this.sharedFolder.shouldConnect &&
			this.sharedFolder.connect().then((connected) => {
				this.connected = true;
				return this.connected;
			})
		);
	}

	public async read(): Promise<string> {
		return this.vault.read(this.tfile);
	}

	public async rename(newPath: string): Promise<void> {
		this.move(newPath);
	}

	public async delete(): Promise<void> {
		return this.vault.delete(this.tfile);
	}

	private async updateStats() {
		const content = await this.vault.readBinary(this.tfile);
		this._filehash = await generateHash(content);
	}

	public async write(content: string): Promise<void> {
		this.vault.adapter.write(this.tfile.path, content);
		this.updateStats();
	}

	public async append(content: string): Promise<void> {
		this.vault.append(this.tfile, content);
		this.updateStats();
	}

	destroy() {
		this.offFolderStatusListener?.();
		this.offFolderStatusListener = null as any;
		this.offFileInfo?.();
		this.offFileInfo = null as any;

		this._parent = null as any;
		this.relayManager = null as any;
		this._tfile = null as any;
	}
}
