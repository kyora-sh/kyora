import type { Regions, VmsClient } from "./api"
import { printJson } from "./output"
import { memory, printTable } from "./session"

/**
 * `kyora-vms regions`: kyora cloud's regions, their machines and what is free on the connected
 * ones, and where a create from here goes; `regions default <id>` makes one yours, `auto` goes
 * back to where you are.
 */
export async function regions(api: VmsClient, args: string[], asJson: boolean): Promise<number> {
  if ((await api.kind()) !== "platform") throw new Error(`${api.url} does not support regions. Use kyora cloud to choose a region`)
  if (args.length > 0) {
    const set = args[1] === "auto" || args[1] === "global" ? null : args[1]!
    const region = await api.setRegion(set)
    if (asJson) printJson({ default: region })
    else {
      console.log(
        region
          ? `your creates go to ${region} and only there; use --region to override, or --region global for automatic region selection`
          : "regions are selected automatically unless you use --region or set a default",
      )
    }
    return 0
  }
  const found: Regions = await api.regions()
  if (asJson) {
    printJson(found)
    return 0
  }
  const rows = [
    ["REGION", "NAME", "VCPU FREE", "MEM FREE", ""],
    ...found.regions.map((region) => [
      region.id,
      region.label,
      String(region.free.vcpus ?? 0),
      memory(region.free.memoryMb ?? 0),
      [region.id === found.you.region ? "← yours" : null, region.jurisdiction ? `data in ${region.jurisdiction}` : null].filter(Boolean).join(" · "),
    ]),
  ]
  printTable(rows)
  const you = found.you
  if (you.by === "your default") console.log(`creates go to ${you.region} and only there: your default (\`kyora-vms regions default global\` to undo; --region global for one create).`)
  else {
    console.log("regions are selected automatically. --region <id> keeps a create in one region.")
  }
  return 0
}
