/** What a VmsClient needs to know, apart from config.ts's file and credential lookups (library.ts has no side effects). */

/** kyora cloud: where a fresh install with nothing configured goes, and what `login` signs in to */
export const DEFAULT_URL = "https://cloud.kyora.sh"
/** where a kyora-vmd key (`kvms_…`) with no KYORA_VMS_URL has always gone */
export const VMD_DEFAULT_URL = "https://vms.kyora.sh"
/** personal tokens kyora cloud mints; kyora-vmd's keys start with kvms_ */
export const PLATFORM_TOKEN_PREFIX = "kyora_"
export const VMD_KEY_PREFIX = "kvms_"

export interface Config {
  url: string
  key: string | null
  /** where the key came from, so `health` can say so without ever printing it */
  keySource: string | null
  urlSource: string
  /** ~/.config/kyora/credentials.json, where `login` keeps its tokens */
  credentials: string
  /** the org (handle) the stored login acts as (`kyora vms org use`); null: personal, or the key isn't a stored login */
  org?: string | null
}

/** what credentials.json is keyed by: scheme, host and port, never a path */
export const originOf = (url: string) => new URL(url).origin
