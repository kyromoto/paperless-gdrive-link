import axios from "axios"
import FormData from "form-data"
import { drive_v3 } from "googleapis"
import { getLogger } from "@logtape/logtape"

import { Account, Config, DriveAccount } from "./types"
import { getDriveClient, listChangesRecursive, listFilesRecursive } from "./lib"




export interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    parents?: string[];
    labels?: { [key: string]: string }
}



export class FileProcessor {

    private readonly logger = getLogger().getChild(["file-processor", this.account.name])

    private driveAccount: DriveAccount
    private driveClient: drive_v3.Drive

    constructor (private readonly config: Config, private readonly account: Account) {

        const driveAccount = this.config.drive_accounts.find(drive => drive.id === this.account.props.drive_account_id)

        if (!driveAccount) {
            throw new Error(`Failed to find drive account for ${this.account.name}`)
        }

        this.driveAccount = driveAccount
        this.driveClient = getDriveClient(driveAccount)

    }



    public async getUnprocessedFiles(mode: "all" | "changes") {
        
        this.logger.info(`Getting unprocessed files...`)

        const mapper = (files: drive_v3.Schema$File[]) => {
            return files.map<DriveFile>(file => {

                if (!file.id) {
                    throw new Error(`File ${file.name} has no id`)
                }
    
                if (!file.name) {
                    throw new Error(`File ${file.name} has no name`)
                }
    
                if (!file.mimeType) {
                    throw new Error(`File ${file.name} has no mime type`)
                }
    
                return {
                    id: file.id,
                    name: file.name,
                    mimeType: file.mimeType
                } 
    
            })
        }

        const all = await listFilesRecursive(this.account, this.driveClient);
        
        switch (mode) {
            case "all": {
                return mapper(all)
            }

            case "changes": {
                const changes = await listChangesRecursive(this.account, this.driveClient)
                const added = all.filter(file => changes.find(change => change.fileId === file.id))
                return mapper(added)
            }

        }
    }


    public async processFile(file: DriveFile) {

        this.logger.info(`Processing file ${file.name}...`, { file })
        
        const content = await this.downloadFileContentFromDrive(file)
        await this.uploadFileToPaperless(file, content)
        await this.moveFile(file)

    }



    private async downloadFileContentFromDrive(file: DriveFile) : Promise<Buffer> {
        
        this.logger.info(`Downloading file ${file.name}...`, { file })

        const res = await this.driveClient.files.get({
            fileId: file.id,
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


    private async uploadFileToPaperless(file: DriveFile, content: Buffer) {

        this.logger.info(`Uploading file ${file.name} to Paperless ...`, { file })

        const endpoint = this.config.paperless_endpoints.find(endpoint => endpoint.id === this.account.props.paperless_endpoint_id)

        if (!endpoint) {
            throw new Error(`Failed to find paperless endpoint for ${this.account.name}`)
        }

        const form = new FormData();
        const url = endpoint.props.server_url + "/api/documents/post_document/"
        const username = endpoint.props.credentials.username
        const password = endpoint.props.credentials.password
        const authHeaderValue = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`

        form.append("document", content, { filename: file.name, contentType: file.mimeType });

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


    private async moveFile(file: DriveFile) {

        this.logger.info(`Moving file ${file.name}...`, { file })

        await this.driveClient.files.update({
            fileId: file.id,
            addParents: this.account.props.drive_dst_folder_id,
            removeParents: this.account.props.drive_src_folder_id
        })

    }


}