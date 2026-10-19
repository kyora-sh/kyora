// the in-VM image builder's sources, which `kyora-vms image build` carries (imported as text; bun
// build inlines them, so the published CLI has them)
declare module "*.py" {
  const text: string
  export default text
}
declare module "*.sh" {
  const text: string
  export default text
}
declare module "*/kyora-image-build" {
  const text: string
  export default text
}
