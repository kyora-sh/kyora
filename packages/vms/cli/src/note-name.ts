let noteName = "kyora"

/** the name in front of every note: `kyora`, or `kyora-vms` when run through that alias */
export function setNoteName(name: string): void {
  noteName = name
}

export const notePrefix = (): string => `[${noteName}]`
