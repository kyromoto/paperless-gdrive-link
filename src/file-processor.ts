import axios from "axios"
import FormData from "form-data"
import { drive_v3 } from "googleapis"
import { getLogger } from "@logtape/logtape"

import { FileStore } from "./file-store"
import { Account, Config } from "./types"
import { getDriveClient, listChangesRecursive, listFilesRecursive } from "./lib"




export interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    parents?: string[];
    labels?: { [key: string]: string }
}


export type CollectChangesJobPayload = {
    accountId: string;
}


export type ProcessChangesJobPayload = {
    accountId: string;
    file: DriveFile
}



export class FileProcessor {

    private readonly logger = getLogger().getChild(["file-processor", this.account.name])

    private driveClient: drive_v3.Drive

    constructor (private readonly config: Config, private readonly fileStore: FileStore, private readonly account: Account) {

        const driveAccount = this.config.drive_accounts.find(drive => drive.id === this.account.props.drive_account_id)

        if (!driveAccount) {
            throw new Error(`Failed to find drive account for ${this.account.name}`)
        }

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
                const changes = await listChangesRecursive(this.config, this.account, this.driveClient)
                const added = all.filter(file => changes.find(change => change.fileId === file.id))
                return mapper(added)
            }

        }
    }


    public async processFile(file: DriveFile) {

        this.logger.info(`Processing file ${file.name}...`, { file })
        
        await this.downloadFileFromDrive(file).catch(err => {
            this.logger.error(`Failed to download file ${file.name} from GDrive`, { err })
            throw err
        })

        await this.uploadFileToPaperless(file).catch(err => {
            this.logger.error(`Failed to upload file ${file.name} to Paperless`, { err })
            throw err
        })
        
        await this.moveFile(file).catch(err => {
            this.logger.error(`Failed to move file ${file.name}`, { err })
            throw err
        })

    }



    private async downloadFileFromDrive(file: DriveFile) {
        
        this.logger.info(`Downloading file ${file.name} from GDrive ...`, { file })

        const res = await this.driveClient.files.get({
            fileId: file.id,
            alt: 'media'
        }, { responseType: 'stream' });

        await this.fileStore.upload(this.getFileStoreName(file), res.data)

    }


    private async uploadFileToPaperless(file: DriveFile) {

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

        const buffer = await this.fileStore.download(this.getFileStoreName(file), { deleteAfterWrite: true })
        form.append("document", buffer, { filename: file.name, contentType: file.mimeType });
        

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


    private getFileStoreName(file: DriveFile) {
        return `${this.account.id}_${file.id}`
    }


}