import * as crypto from "crypto";

import { JWT } from "google-auth-library";
import { google } from "googleapis";
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






const LABEL = 'processed';



export class Processor {

    private readonly logger = getLogger()
    private readonly queue = new InMemoryQueue(this.handleQueueItem.bind(this))
    private readonly accountChannelMap = new Map<string, string>();

    constructor (
        private readonly config: Config,
    ) {}


    public async start () {

        this.logger.info('Starting processor...')
        
        this.initChannelIds();
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



    private async setupPushNotification (account: Account) {

        this.logger.info(`${account.id}: Setting up push notification...`) 
         
        const driveAccount = this.getDriveAccount(account.id);
        const fileId = this.getDriveSrcFolderId(account.id);
        const channelId = crypto.randomUUID();
        const webhookUrl = `${this.config.server.webhook_url}/webhook/${account.id}`;
        
        const drive = this.getDriveClient(account.id);
        const expirationTimestapMS = Date.now() + (driveAccount.props.channel_expiration_sec * 1000)


        const channel = await drive.files.watch({
            fileId,
            requestBody: {
                id: channelId,
                type: 'webhook',
                address: webhookUrl,
                payload: true,
                expiration: expirationTimestapMS.toString()
            }
        })

        const timer = setTimeout(async () => {
            this.logger.info(`${account.id}: Refreshing push notification...`)
            clearTimeout(timer)
            await this.setupPushNotification(account).catch(err => {
                this.logger.error(`${account.id}: Refresh push notification failed: ${err.message || err}`, { error: err })
                process.exit(1);
            })
        }, driveAccount.props.channel_expiration_sec * 0.1 * 1000)

        await drive.channels.stop({
            requestBody: {
                id: channel.data.id
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

        const drive = this.getDriveClient(accountId);
        const folderId = this.getDriveSrcFolderId(accountId);

        const getFilesRecursive = async (nextPageToken?: string) : Promise<DriveFile[]> => {
            const res = await drive.files.list({
                q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
                fields: 'nextPageToken, files(id, name, size, properties, mimeType, createdTime, modifiedTime)',
                orderBy: "modifiedTime desc",
                pageSize: 100,
                ...(nextPageToken && { pageToken: nextPageToken })
            })

            const curr = (res.data.files || []) as DriveFile[];
            const next = res.data.nextPageToken;
            
            if (!next) return curr;

            return curr.concat(await getFilesRecursive(next));
        }

        const files = await getFilesRecursive();
        const unprocessedFiles = files.filter(f => !f.labels?.[LABEL]);

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

}
