# PDF Watermark Stamper — specification

**Tagline:** Add a text or image watermark like CONFIDENTIAL to every PDF page in your browser, with no upload.

**Category:** PDF

**Free alternative to:** Smallpdf and iLovePDF Watermark PDF (uploads documents, daily free limits, paid plan for batch and image stamps)

**Search phrases:** add watermark to pdf, pdf watermark online free, stamp confidential on pdf, watermark pdf with image, draft watermark pdf, diagonal watermark pdf

**Allowed libraries:** pdf-lib

**Published at:** https://turhe123.github.io/pdf-watermark-stamper/

## Acceptance checks (each must have a test)

- loading the bundled sample and entering DRAFT produces a PDF with the same page count
- the preview shows the text rotated at 45 degrees with the chosen opacity
- choosing a PNG logo embeds it on every page
- restricting to pages 2-3 leaves page 1 unmarked
- layout works at 390px wide

## Spec

Add watermark to pdf is a steady search from people who need to mark documents as draft, confidential or copy. Incumbents upload the file, limit free runs and put image stamps and batch use behind a paid plan. Since watermarked files are usually sensitive business documents, local processing is attractive.

Our version does one job: stamp a text or an image watermark on selected pages. It does not remove watermarks and does not edit other content.

UI: drop zone for one PDF. A mode toggle picks Text or Image. Text options: the text (default CONFIDENTIAL), font (Helvetica Bold default, Times, Courier), size (default 64), color (default red), opacity slider (default 25 percent), rotation (default 45 degrees), and position (center default, tiled option). Image options: choose a PNG or JPG, scale slider and the same opacity, rotation and position controls. A page range field defaults to all pages. A live preview canvas shows the first page outline with the stamp scaled over it, and a page stepper. A Apply and Download button saves name_watermarked.pdf. Layer option: over content or under content, default over. Empty state explains privacy and errors are inline. Keyboard: Enter in text field refreshes the preview.

Technical approach: pdf-lib loads the file, embeds the standard font or the image through embedPng and embedJpg, and for each target page calls drawText or drawImage with opacity, rotate using degrees, and coordinates computed so the stamp is centered after rotation using trigonometry on the measured width and height. Tiled mode loops over a grid with spacing. Under content layering is achieved by inserting a new page-sized content stream before existing content, which can be done by drawing on a freshly created page and embedding the original page with embedPage, so we use that fallback: embed the original page, draw the stamp, then draw the page on top. Preview is a schematic page box scaled from the first page size with a canvas drawn stamp. Save and download via Blob.

Edge cases: standard fonts are Latin only, so non Latin text triggers a message suggesting the image mode where the user can render text into an image, offered through a built in button that draws the text on a canvas and uses it as the image, which supports Unicode. Pages with rotation need adjusted angles, huge images are downscaled on a canvas to 2000 pixels, transparent PNGs keep alpha, encrypted files show an unsupported message, and mobile Safari downloads start on tap.

Demo data: a bundled fictional three page PDF named Draft Service Agreement between Harbor Legal Demo and Cedar Works, plus a small transparent PNG logo of a blue circle for the image mode.
