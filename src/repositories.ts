import { Config } from "./types";



export interface ConfigRepository {
    read: () => Promise<Config>
}