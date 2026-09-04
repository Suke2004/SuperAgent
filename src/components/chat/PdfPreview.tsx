// TypeScript's resolver does not apply React Native platform suffixes. Metro will
// select PdfPreview.native.tsx or PdfPreview.web.tsx at bundle time.
export { PdfPreview } from './PdfPreview.native';
