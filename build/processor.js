"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Processor = void 0;
const crypto = __importStar(require("crypto"));
const google_auth_library_1 = require("google-auth-library");
const googleapis_1 = require("googleapis");
const logtape_1 = require("@logtape/logtape");
const express_1 = __importDefault(require("express"));
const axios_1 = __importDefault(require("axios"));
const form_data_1 = __importDefault(require("form-data"));
const queue_1 = require("./queue");
const LABEL = 'processed';
class Processor {
    constructor(config) {
        this.config = config;
        this.logger = (0, logtape_1.getLogger)();
        this.queue = new queue_1.InMemoryQueue(this.handleQueueItem.bind(this));
        this.accountChannelMap = new Map();
        // --- Helpers ---
        this.getAccount = (config, accountId) => {
            return config.accounts.find(a => a.id === accountId);
        };
        this.getDriveClient = (accountId) => {
            const account = this.config.accounts.find(a => a.id === accountId);
            const driveEndpoint = this.config.drive_accounts.find(de => de.id === account.props.drive_account_id);
            const drive = googleapis_1.google.drive({
                version: 'v3',
                auth: new google_auth_library_1.JWT({
                    email: driveEndpoint.props.credentials.client_email,
                    key: driveEndpoint.props.credentials.private_key,
                    scopes: ['https://www.googleapis.com/auth/drive']
                })
            });
            return drive;
        };
        this.getPaperlessEndpoint = (accountId) => {
            const account = this.config.accounts.find(a => a.id === accountId);
            const paperlessEndpoint = this.config.paperless_endpoints.find(pe => pe.id === account.props.paperless_endpoint_id);
            return paperlessEndpoint;
        };
        this.getDriveAccount = (accountId) => {
            const account = this.config.accounts.find(a => a.id === accountId);
            const driveAccount = this.config.drive_accounts.find(de => de.id === account.props.drive_account_id);
            return driveAccount;
        };
    }
    start() {
        return __awaiter(this, void 0, void 0, function* () {
            this.logger.info('Starting processor...');
            this.initChannelIds();
            yield Promise.all(this.config.accounts.map(account => this.processExistingFiles(account)));
            yield Promise.all(this.config.accounts.map(account => this.setupPushNotification(account)));
            this.startServer();
        });
    }
    // --- Initalizers ---
    initChannelIds() {
        this.logger.info('Initializing channel ids...');
        for (const account of this.config.accounts) {
            this.accountChannelMap.set(account.id, crypto.randomUUID());
        }
    }
    setupPushNotification(account) {
        return __awaiter(this, void 0, void 0, function* () {
            this.logger.info(`${account.id}: Setting up push notification...`);
            const driveAccount = this.getDriveAccount(account.id);
            const fileId = this.getDriveSrcFolderId(account.id);
            const channelId = crypto.randomUUID();
            const webhookUrl = `${this.config.server.webhook_url}/webhook/${account.id}`;
            const drive = this.getDriveClient(account.id);
            const expirationTimestapMS = Date.now() + (driveAccount.props.channel_expiration_sec * 1000);
            const channel = yield drive.files.watch({
                fileId,
                requestBody: {
                    id: channelId,
                    type: 'webhook',
                    address: webhookUrl,
                    payload: true,
                    expiration: expirationTimestapMS.toString()
                }
            });
            const timer = setTimeout(() => __awaiter(this, void 0, void 0, function* () {
                this.logger.info(`${account.id}: Refreshing push notification...`);
                clearTimeout(timer);
                yield this.setupPushNotification(account).catch(err => {
                    this.logger.error(`${account.id}: Refresh push notification failed: ${err.message || err}`, { error: err });
                    process.exit(1);
                });
            }), driveAccount.props.channel_expiration_sec * 0.1 * 1000);
            yield drive.channels.stop({
                requestBody: {
                    id: channel.data.id
                }
            });
        });
    }
    startServer() {
        this.logger.info('Starting server...');
        const port = this.config.server.port;
        const app = (0, express_1.default)();
        app.use(express_1.default.json());
        app.get('/health', this.handleHealthCheck.bind(this));
        app.post('/webhook/:accountId', this.handleWebhook.bind(this));
        app.once('error', err => {
            this.logger.error('Server error', err.message || err);
            process.exit(1);
        });
        app.listen(port, () => {
            this.logger.info(`Server started on port ${port}`);
        });
    }
    // --- API Controllers ---
    handleWebhook(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            this.logger.info('Handling webhook...');
            const channelId = req.get('X-Goog-Channel-Id');
            const state = req.get('X-Goog-Resource-State');
            this.logger.info(`Received webhook for ChannelId ${channelId} with state ${state}`);
            if (state !== "update") {
                res.status(200).send("OK");
                return;
            }
            const channelIdMapItem = Array.from(this.accountChannelMap.entries()).find(item => {
                return item[1] === channelId;
            });
            if (!channelIdMapItem) {
                res.status(200).send("OK");
                return;
            }
            const accountId = channelIdMapItem[0];
            const files = yield this.getUnprocessedFiles(accountId);
            yield Promise.all(files.map(file => this.queue.enqueue({ owner: accountId, file })));
            res.status(200).send("OK");
        });
    }
    handleHealthCheck(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            res.status(200).json({ status: "OK" });
        });
    }
    // --- Use cases ---
    processExistingFiles(account) {
        return __awaiter(this, void 0, void 0, function* () {
            this.logger.info(`${account.id}: Processing existing files ...`);
            const files = yield this.getUnprocessedFiles(account.id);
            yield Promise.all(files.map(file => this.queue.enqueue({ owner: account.id, file })));
        });
    }
    getUnprocessedFiles(accountId) {
        return __awaiter(this, void 0, void 0, function* () {
            this.logger.info(`${accountId}: Getting unprocessed files ...`);
            const drive = this.getDriveClient(accountId);
            const folderId = this.getDriveSrcFolderId(accountId);
            const getFilesRecursive = (nextPageToken) => __awaiter(this, void 0, void 0, function* () {
                const res = yield drive.files.list(Object.assign({ q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`, fields: 'nextPageToken, files(id, name, size, properties, mimeType, createdTime, modifiedTime)', orderBy: "modifiedTime desc", pageSize: 100 }, (nextPageToken && { pageToken: nextPageToken })));
                const curr = (res.data.files || []);
                const next = res.data.nextPageToken;
                if (!next)
                    return curr;
                return curr.concat(yield getFilesRecursive(next));
            });
            const files = yield getFilesRecursive();
            const unprocessedFiles = files.filter(f => { var _a; return !((_a = f.labels) === null || _a === void 0 ? void 0 : _a[LABEL]); });
            return unprocessedFiles;
        });
    }
    handleQueueItem(job) {
        return __awaiter(this, void 0, void 0, function* () {
            this.logger.info(`${job.owner}: Processing file ${job.file.name} ...`, job);
            const stream = yield this.downloadFileFromDrive(job).catch(err => { throw new queue_1.JobProcessingError(err.message, true); });
            yield this.uploadFileToPaperless(job, stream).catch(err => { throw new queue_1.JobProcessingError(err.message, true); });
            yield this.moveFile(job).catch(err => { throw new queue_1.JobProcessingError(err.message, false); });
        });
    }
    ;
    downloadFileFromDrive(job) {
        return __awaiter(this, void 0, void 0, function* () {
            this.logger.info(`${job.owner}: Downloading file ${job.file.name} ...`, job);
            const drive = this.getDriveClient(job.owner);
            const res = yield drive.files.get({
                fileId: job.file.id,
                alt: 'media'
            }, { responseType: 'stream' });
            const buffer = yield new Promise((resolve, reject) => {
                const chunks = [];
                res.data.on('data', (chunk) => chunks.push(chunk));
                res.data.on('end', () => resolve(Buffer.concat(chunks)));
                res.data.on('error', (err) => reject(err));
            });
            return buffer;
        });
    }
    uploadFileToPaperless(job, content) {
        return __awaiter(this, void 0, void 0, function* () {
            this.logger.info(`${job.owner}: Uploading file ${job.file.name} to Paperless ...`);
            const form = new form_data_1.default();
            const endpoint = this.getPaperlessEndpoint(job.owner);
            const url = endpoint.props.server_url + "/api/documents/post_document/";
            const username = endpoint.props.credentials.username;
            const password = endpoint.props.credentials.password;
            const authHeaderValue = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
            form.append("document", content, { filename: job.file.name, contentType: job.file.mimeType });
            const res = yield axios_1.default.request({
                method: 'post',
                url,
                data: form,
                headers: {
                    Authorization: authHeaderValue
                }
            });
            if (res.status !== 200) {
                throw new Error(`Paperless upload failed: ${res.statusText}`);
            }
        });
    }
    moveFile(job) {
        return __awaiter(this, void 0, void 0, function* () {
            this.logger.info(`${job.owner}: Moving file ${job.file.name} ...`);
            const drive = this.getDriveClient(job.owner);
            // await drive.files.update({
            //     fileId: job.file.id,
            //     requestBody: {
            //         trashed: true
            //     }
            // })
            const src = this.getDriveSrcFolderId(job.owner);
            const dst = this.getDriveDstFolderId(job.owner);
            yield drive.files.update({
                fileId: job.file.id,
                addParents: dst,
                removeParents: src
            });
        });
    }
    getDriveSrcFolderId(accountId) {
        const account = this.config.accounts.find(a => a.id === accountId);
        return account.props.drive_src_folder_id;
    }
    getDriveDstFolderId(accountId) {
        const account = this.config.accounts.find(a => a.id === accountId);
        return account.props.drive_dst_folder_id;
    }
}
exports.Processor = Processor;
