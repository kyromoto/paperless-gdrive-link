
import fs from "node:fs" 
import fsPromises from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"


export class FileStore {

    private _initialized = false

    constructor(private readonly path: string) {}


    public async init() {
        await this.createPathIfNotExists()
        this._initialized = true
    }


    public async upload(id: string, content: Readable) {
        this.checkInitialized()
        const filename = this.getFilename(id)
        const writer = fs.createWriteStream(filename)
        await pipeline(content, writer)
    }

    public async download(id: string, opts?: { deleteAfterWrite?: boolean }) {
        this.checkInitialized()
        const filename = this.getFilename(id)
        const reader = fs.createReadStream(filename)
        
        const buffer = await new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            reader.on('data', chunk => chunks.push(chunk as Buffer));
            reader.on('end', () => resolve(Buffer.concat(chunks)));
            reader.on('error', (err: Error) => reject(err));
        })

        if (opts?.deleteAfterWrite) {
            await fsPromises.unlink(filename)
        }

        return buffer
    }


    private getFilename(id: string) {
        return path.join(this.path, id)
    }

    private async createPathIfNotExists() {
        await fsPromises.access(this.path, fs.constants.W_OK).catch(async err => {
            await fsPromises.mkdir(this.path, { recursive: true })
        })
    }

    private checkInitialized() {
        if (!this._initialized) {
            throw new Error("FileStore is not initialized")
        }
    }

}