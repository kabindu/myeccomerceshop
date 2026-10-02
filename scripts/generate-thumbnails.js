/* One-off (re-runnable) build step: generates a small webp thumbnail for
   every product image, used by the shop grid instead of the full-size
   original (which the product detail page still uses for its gallery).
   Requires the sharp devDependency - not needed at runtime, only to
   produce the thumbnail files, which get committed like any other
   static asset. Run manually:

     node scripts/generate-thumbnails.js
*/
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const sourceDir = path.join(__dirname, '..', 'images', 'products');
const thumbDir = path.join(sourceDir, 'thumbs');
const THUMB_WIDTH = 480;

async function main() {
  fs.mkdirSync(thumbDir, { recursive: true });
  const files = fs.readdirSync(sourceDir).filter(name => {
    const full = path.join(sourceDir, name);
    return fs.statSync(full).isFile() && /\.(png|jpe?g|webp|avif)$/i.test(name);
  });

  console.log(`Generating thumbnails for ${files.length} image(s)...`);
  let totalBefore = 0;
  let totalAfter = 0;

  for (const file of files) {
    const sourcePath = path.join(sourceDir, file);
    const thumbName = file.replace(/\.[^.]+$/, '.webp');
    const thumbPath = path.join(thumbDir, thumbName);
    const before = fs.statSync(sourcePath).size;
    const buffer = await sharp(sourcePath).resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
    fs.writeFileSync(thumbPath, buffer);
    totalBefore += before;
    totalAfter += buffer.length;
    console.log(`${file}: ${Math.round(before / 1024)}KB -> thumbs/${thumbName}: ${Math.round(buffer.length / 1024)}KB`);
  }

  console.log('---');
  console.log(`Total: ${Math.round(totalBefore / 1024)}KB -> ${Math.round(totalAfter / 1024)}KB`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
