import sharp from 'sharp';
import { readdir } from 'fs/promises';
import { join } from 'path';

const SCREENSHOTS_DIR = './public/screenshots';
const GUIDES = ['submit-project', 'shop-purchase', 'customize-character'];

async function optimizeAll() {
  for (const guide of GUIDES) {
    const guidePath = join(SCREENSHOTS_DIR, guide);
    const files = await readdir(guidePath);
    const pngFiles = files.filter(f => f.endsWith('.png'));
    
    for (const png of pngFiles) {
      const inputPath = join(guidePath, png);
      const outputPath = join(guidePath, png.replace('.png', '.webp'));
  
      await sharp(inputPath)
        .resize(900, 900, { fit: 'inside', withoutEnlargement: true })
 .webp({ quality: 85 })
        .toFile(outputPath);
      
      console.log(`✓ ${guide}/${png} → ${png.replace('.png', '.webp')}`);
    }
  }
  console.log('\n✓ All screenshots optimized to WebP');
}

optimizeAll().catch(console.error);
