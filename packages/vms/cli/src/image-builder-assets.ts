import { createHash } from "node:crypto"
import builder from "../../image/builder/kyora-image-build" with { type: "text" }
import chrootInstall from "../../image/rootfs/chroot-install.sh" with { type: "text" }
import apt from "../../image/rootfs/stages/apt.sh" with { type: "text" }
import delta from "../../image/rootfs/stages/delta.sh" with { type: "text" }
import extras from "../../image/rootfs/stages/extras.sh" with { type: "text" }
import kyora from "../../image/rootfs/stages/kyora.sh" with { type: "text" }
import toolchains from "../../image/rootfs/stages/toolchains.sh" with { type: "text" }
import imagespec from "../../image/tools/imagespec.py" with { type: "text" }
import profiles from "../../image/tools/profiles.py" with { type: "text" }

/**
 * The in-VM image builder (packages/vms/image/builder/kyora-image-build) and what it needs, carried
 * in the CLI: the images on kyora's machines today were built before the builder shipped in them, so
 * `kyora-vms image build` uploads its own copy into the builder sandbox. Laid out as the builder
 * looks for them: its library (imagespec.py, profiles.py) with chroot-install.sh next to it and the
 * stage files under stages/.
 */
export const BUILDER_FILES: Readonly<Record<string, { text: string; mode: number }>> = {
  "kyora-image-build": { text: builder, mode: 0o755 },
  "lib/imagespec.py": { text: imagespec, mode: 0o644 },
  "lib/profiles.py": { text: profiles, mode: 0o644 },
  "lib/chroot-install.sh": { text: chrootInstall, mode: 0o755 },
  "lib/stages/apt.sh": { text: apt, mode: 0o644 },
  "lib/stages/toolchains.sh": { text: toolchains, mode: 0o644 },
  "lib/stages/extras.sh": { text: extras, mode: 0o644 },
  "lib/stages/kyora.sh": { text: kyora, mode: 0o644 },
  "lib/stages/delta.sh": { text: delta, mode: 0o644 },
}

/** sha256 over the builder's files: part of every content key, so a different builder builds anew */
export const BUILDER_HASH: string = (() => {
  const hash = createHash("sha256")
  for (const [path, file] of Object.entries(BUILDER_FILES).sort(([a], [b]) => (a < b ? -1 : 1))) hash.update(`${path}\0${file.mode}\0${file.text.length}\0${file.text}`)
  return `sha256:${hash.digest("hex")}`
})()
