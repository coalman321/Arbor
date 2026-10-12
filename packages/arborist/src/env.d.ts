// Vite's ?inline imports: a stylesheet's text, bundled.
declare module "*.css?inline" {
  const css: string;
  export default css;
}
