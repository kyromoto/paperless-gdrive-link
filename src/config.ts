import fs from 'node:fs/promises'

import { getLogger } from '@logtape/logtape'

import { Config } from './types'
import { ConfigRepository } from "./processor"



export class ConfigFileRepository implements ConfigRepository {

    private logger = getLogger();

    constructor (private readonly path: string) {}

    public async read () {

        this.logger.debug(`Reading config from ${this.path}`)

        const data = await fs.readFile(this.path, 'utf-8')
        const json = JSON.parse(data)
        const config = await Config.parseAsync(json)

        return config
    }


    public async write (config: Config) {

        this.logger.debug(`Writing config to ${this.path}`)

        const json = JSON.stringify(config, null, 2)
        await fs.writeFile(this.path, json)
    }
}