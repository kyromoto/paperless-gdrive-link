import * as crypto from "crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { JWT } from "google-auth-library";
import { drive_v3, google } from "googleapis";
import { getLogger } from "@logtape/logtape";
import express, { Request, Response } from "express";
import axios from "axios";
import FormData from "form-data";

import { Account, Config } from "./types";
import { InMemoryQueue, JobProcessingError } from "./queue";



export interface ConfigRepository {
    read: () => Promise<Config>
}


export interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    parents?: string[];
    labels?: { [key: string]: string }
}

export type QueueJob = { owner: string, file: DriveFile }
export type QueueWorker = (job: QueueJob) => Promise<void>
export interface Queue {
    enqueue: (job: QueueJob) => void
}




export class Processor {

    private readonly logger = getLogger()
    private readonly queue = new InMemoryQueue(this.handleQueueItem.bind(this))
    private readonly accountChannelMap = new Map<string, string>();

    constructor (
        private readonly config: Config,
    ) {}


    public async start () {

        this.logger.info('Starting processor...')

        process.on('SIGINT', this.handleShutdown.bind(this))
        process.on('SIGTERM', this.handleShutdown.bind(this))
        process.on('SIGHUP', this.handleShutdown.bind(this))
        process.on('uncaughtException', this.handleShutdown.bind(this))
        process.on('unhandledRejection', this.handleShutdown.bind(this))

        
        
        this.initChannelIds();
        await Promise.all(this.config.accounts.map(account => this.initPageToken(account)))
        await Promise.all(this.config.accounts.map(account => this.processExistingFiles(account)))
        await Promise.all(this.config.accounts.map(account => this.setupPushNotification(account)));
        
        this.startServer()
    }

    



    // --- Initalizers ---

    private initChannelIds () {

        this.logger.info('Initializing channel ids...')

        for (const account of this.config.accounts) {
            this.accountChannelMap.set(account.id, crypto.randomUUID());
        }
    }


    private async initPageToken(account: Account) {

        this.logger.info(`${account.id}: Initializing page token...`)

        const drive = this.getDriveClient(account.id);
        const res = await drive.changes.getStartPageToken({})
        const token = res.data.startPageToken

        if (!token) {
            throw new Error(`Failed to get start page token for ${account.name}`)
        }

        await this.saveChangeToken(account.id, token)

    }



    private async setupPushNotification (account: Account) {

        this.logger.info(`${account.id}: Setting up push notification...`) 
         
        const driveAccount = this.getDriveAccount(account.id)
        const fileId = this.getDriveSrcFolderId(account.id)
        const channelId = crypto.randomUUID()
        const webhookUrl = `${this.config.server.webhook_url}/webhook/${account.id}`
        const drive = this.getDriveClient(account.id);
        const expirationTimestapMS = Date.now() + (driveAccount.props.channel_expiration_sec * 1000)

        await drive.files.watch({
            fileId,
            requestBody: {
                id: channelId,
                type: 'webhook',
                address: webhookUrl,
                payload: true,
                expiration: expirationTimestapMS.toString()
            }
        })

        this.accountChannelMap.set(account.id, channelId);

        const timer = setTimeout(async () => {
            clearTimeout(timer)
            await this.refreshPushNotification(account)
        }, driveAccount.props.channel_expiration_sec * 0.9 * 1000)

    }



    private async refreshPushNotification(account: Account) {

        this.logger.info(`${account.id}: Refreshing push notification...`)

        const drive = this.getDriveClient(account.id);
        const channelId = this.accountChannelMap.get(account.id)
        if (!channelId) throw new Error('ChannelId not found')

        await this.setupPushNotification(account)

        await drive.channels.stop({
            requestBody: {
                id: channelId
            }
        })

    }


    private startServer () {

        this.logger.info('Starting server...')

        const port = this.config.server.port
        const app = express();

        app.use(express.json());
        app.get('/health', this.handleHealthCheck.bind(this));
        app.post('/webhook/:accountId', this.handleWebhook.bind(this))
        
        app.once('error', err => {
            this.logger.error('Server error', err.message || err);
            process.exit(1);
        })
        
        app.listen(port, () => {
            this.logger.info(`Server started on port ${port}`)
        })

    }



    // --- API Controllers ---

    private async handleWebhook (req: Request, res: Response) {

        this.logger.info('Handling webhook...')

        const channelId = req.get('X-Goog-Channel-Id')!;
        const state = req.get('X-Goog-Resource-State')!;

        this.logger.info(`Received webhook for ChannelId ${channelId} with state ${state}`)

        if (state !== "update") {
            res.status(200).send("OK");
            return;
        }

        const channelIdMapItem = Array.from(this.accountChannelMap.entries()).find(item => {
            return item[1] === channelId
        })

        if (!channelIdMapItem) {
            res.status(200).send("OK");
            return;
        }

        const accountId = channelIdMapItem[0];
        const files = await this.getUnprocessedFiles(accountId);

        await Promise.all(files.map(file => this.queue.enqueue({ owner: accountId, file })));

        res.status(200).send("OK");

    }



    private async handleHealthCheck (req: Request, res: Response) {
        res.status(200).json({ status: "OK" });
    }



    // --- Use cases ---

    private async processExistingFiles (account: Account) {

        this.logger.info(`${account.id}: Processing existing files ...`)

        const files = await this.getUnprocessedFiles(account.id);

        await Promise.all(files.map(file => this.queue.enqueue({ owner: account.id, file })));

    }



    private async getUnprocessedFiles (accountId: string): Promise<DriveFile[]> {

        this.logger.info(`${accountId}: Getting unprocessed files ...`)

        const drive = this.getDriveClient(accountId)
        const folderId = this.getDriveSrcFolderId(accountId)
        const changeToken = await this.getChangeToken(accountId).catch(err => {
            this.logger.error(`Failed to get change token: ${err.message}`, { error: err })
            return undefined
        })

        const listChangesRecursive = async (pageToken?: string): Promise<{ pageToken: string | undefined | null, changes: drive_v3.Schema$Change[] }> => {
            
            const res = await drive.changes.list({
                spaces: 'drive',
                includeRemoved: true,
                pageSize: 100,
                ...(pageToken && { pageToken })
            })

            const changes = res.data.changes || [];
            const next = res.data.nextPageToken;

            if (!next) return { changes, pageToken: res.data.newStartPageToken }

            return {
                pageToken: res.data.newStartPageToken,
                changes: [
                    ...changes,
                    ...(await listChangesRecursive(next)).changes
                ]
            }
        }

        const listFilesRecursive = async (pageToken?: string) : Promise<DriveFile[]> => {
            
            const res = await drive.files.list({
                q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
                fields: 'nextPageToken, files(id, name, size, properties, mimeType, createdTime, modifiedTime)',
                orderBy: "modifiedTime desc",
                pageSize: 100,
                ...(pageToken && { pageToken })
            })

            const curr = (res.data.files || []) as DriveFile[];
            const next = res.data.nextPageToken;
            
            if (!next) return curr;

            return curr.concat(await listFilesRecursive(next));

        }



        const { changes, pageToken } = await listChangesRecursive(changeToken)
        const files = await listFilesRecursive();

        if (pageToken) {
            await this.saveChangeToken(accountId, pageToken);
        }

        const unprocessedFiles = files.filter(file => {
            return !! changes.find(change => change.fileId === file.id)
        })

        return unprocessedFiles;

    }



    private async handleQueueItem (job: QueueJob) {

        this.logger.info(`${job.owner}: Processing file ${job.file.name} ...`, job)

        const stream = await this.downloadFileFromDrive(job).catch(err => { throw new JobProcessingError(err.message, true) });
        await this.uploadFileToPaperless(job, stream).catch(err => { throw new JobProcessingError(err.message, true) });
        await this.moveFile(job).catch(err => { throw new JobProcessingError(err.message, false) });

    };



    private async downloadFileFromDrive (job: QueueJob) {

        this.logger.info(`${job.owner}: Downloading file ${job.file.name} ...`, job)
    
        const drive = this.getDriveClient(job.owner);
    
        const res = await drive.files.get({
            fileId: job.file.id,
            alt: 'media'
        }, { responseType: 'stream' });

        const buffer = await new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            res.data.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.data.on('end', () => resolve(Buffer.concat(chunks)));
            res.data.on('error', (err: Error) => reject(err));
        })

        return buffer

    }



    private async uploadFileToPaperless (job: QueueJob, content: Buffer) {

        this.logger.info(`${job.owner}: Uploading file ${job.file.name} to Paperless ...`)

        const form = new FormData();
        const endpoint = this.getPaperlessEndpoint(job.owner);

        const url = endpoint.props.server_url + "/api/documents/post_document/"
        const username = endpoint.props.credentials.username
        const password = endpoint.props.credentials.password
        const authHeaderValue = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`

        form.append("document", content, { filename: job.file.name, contentType: job.file.mimeType });

        const res = await axios.request({
            method: 'post',
            url,
            data: form,
            headers: {
                Authorization: authHeaderValue
            }
        })

        if (res.status !== 200) {
            throw new Error(`Paperless upload failed: ${res.statusText}`);
        }

    }



    private async moveFile (job: QueueJob) {

        this.logger.info(`${job.owner}: Moving file ${job.file.name} ...`)

        const drive = this.getDriveClient(job.owner);

        // await drive.files.update({
        //     fileId: job.file.id,
        //     requestBody: {
        //         trashed: true
        //     }
        // })

        const src = this.getDriveSrcFolderId(job.owner);
        const dst = this.getDriveDstFolderId(job.owner);

        await drive.files.update({
            fileId: job.file.id,
            addParents: dst,
            removeParents: src
        })

    }



    private async handleShutdown () {

        await Promise.all(this.config.accounts.map(async account => {

            this.logger.info(`${account.id}: Stopping push notification...`)

            const drive = this.getDriveClient(account.id);
            await drive.channels.stop({
                requestBody: {
                    id: this.accountChannelMap.get(account.id)!
                }
            })
        })).catch(err => {
            this.logger.error(`Failed to stop push notification: ${err.message}`, { error: err })
        })

    }



    // --- Helpers ---

    private getAccount = (config: Config, accountId: string) => {
        return config.accounts.find(a => a.id === accountId)!;
    }



    private getDriveClient = (accountId: string) => {

        const account = this.config.accounts.find(a => a.id === accountId)!;
        const driveEndpoint = this.config.drive_accounts.find(de => de.id === account.props.drive_account_id)!;

        const drive = google.drive({
            version: 'v3',
            auth: new JWT({
                email: driveEndpoint.props.credentials.client_email,
                key: driveEndpoint.props.credentials.private_key,
                scopes: ['https://www.googleapis.com/auth/drive']
            })
        })

        return drive;
    }



    private getDriveSrcFolderId (accountId: string) {
        const account = this.config.accounts.find(a => a.id === accountId)!;
        return account.props.drive_src_folder_id
    }


    private getDriveDstFolderId (accountId: string) {
        const account = this.config.accounts.find(a => a.id === accountId)!;
        return account.props.drive_dst_folder_id
    }



    private getPaperlessEndpoint = (accountId: string) => {
        
        const account = this.config.accounts.find(a => a.id === accountId)!;
        const paperlessEndpoint = this.config.paperless_endpoints.find(pe => pe.id === account.props.paperless_endpoint_id)!;

        return paperlessEndpoint;
    }



    private getDriveAccount = (accountId: string) => {

        const account = this.config.accounts.find(a => a.id === accountId)!;
        const driveAccount = this.config.drive_accounts.find(de => de.id === account.props.drive_account_id)!;

        return driveAccount;

    }


    private async saveChangeToken (accountId: string, changeToken: string) {

        this.logger.info(`${accountId}: Saving change token...`)

        const filepath = path.join(this.config.server.data_path, `${accountId}.change-token.txt`)
        await fs.writeFile(filepath, changeToken)
    }

    private async getChangeToken (accountId: string) {

        this.logger.info(`${accountId}: Getting change token...`)

        const filepath = path.join(this.config.server.data_path, `${accountId}.change-token.txt`)
        const raw = await fs.readFile(filepath, "utf-8")
        const token = raw.trim()
        return token
    }

}
