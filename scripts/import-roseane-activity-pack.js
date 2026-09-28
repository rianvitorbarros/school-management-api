/*
 * Idempotent catalog importer. It preserves the supplied originals verbatim;
 * only the separate thumbnail is resized for the library grid.
 *
 * Usage: ACTIVITY_PACK_ADMIN_ID=<platform-admin ObjectId> node scripts/import-roseane-activity-pack.js
 */
const fs = require('fs/promises');
const path = require('path');
const mongoose = require('mongoose');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
require('dotenv').config();

const connectDB = require('../src/config/database');
const ActivityBook = require('../src/api/models/activityBook.model');
const ActivityPage = require('../src/api/models/activityPage.model');
const r2StorageService = require('../src/api/services/r2Storage.service');

const pack = {
  slug: 'roseane',
  title: 'Caderno de Atividades - Roseane',
  description: 'Pack de atividades da Professora Roseane.',
  sourceDir: path.resolve(__dirname, '../assets/activity-packs/roseane'),
  pageCount: 9,
};

async function makeThumbnail(buffer) {
  const image = await loadImage(buffer);
  const width = 600;
  const height = Math.round((image.height / image.width) * width);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return canvas.toBuffer('image/png');
}

async function main() {
  const adminId = String(process.env.ACTIVITY_PACK_ADMIN_ID || '').trim();
  if (!mongoose.Types.ObjectId.isValid(adminId)) {
    throw new Error('Defina ACTIVITY_PACK_ADMIN_ID com o ObjectId de um PlatformAdmin.');
  }
  await connectDB();
  let book = await ActivityBook.findOne({ title: pack.title });
  if (!book) {
    book = await ActivityBook.create({
      title: pack.title,
      description: pack.description,
      sourceType: 'global',
      visibility: 'global',
      status: 'published',
      totalPages: pack.pageCount,
      createdBy: adminId,
      thumbnailsStatus: 'ready',
      thumbnailsTotal: pack.pageCount,
      thumbnailsReady: pack.pageCount,
      defaultHeaderOverlay: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 18 },
    });
  }
  for (let number = 1; number <= pack.pageCount; number += 1) {
    const original = await fs.readFile(path.join(pack.sourceDir, `${number}.png`));
    const baseKey = `platform/activity-packs/${pack.slug}/pages/${String(number).padStart(3, '0')}`;
    const sourceImageKey = `${baseKey}.png`;
    const thumbnailKey = `${baseKey}.thumbnail.png`;
    await r2StorageService.uploadBuffer({ key: sourceImageKey, buffer: original, contentType: 'image/png' });
    await r2StorageService.uploadBuffer({ key: thumbnailKey, buffer: await makeThumbnail(original), contentType: 'image/png' });
    await ActivityPage.findOneAndUpdate(
      { bookId: book._id, pageNumber: number },
      { $set: {
        title: `Atividade ${String(number).padStart(2, '0')}`,
        description: 'Autora: Professora Roseane',
        sourceKind: 'image',
        sourceImageKey,
        sourceImageContentType: 'image/png',
        thumbnailKey,
        thumbnailStatus: 'ready',
        thumbnailContentType: 'image/png',
        enabled: true,
        printable: true,
        pageType: 'activity',
        status: 'published',
        headerOverlay: { xPct: 0, yPct: 0, widthPct: 100, heightPct: 18 },
      } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
  }
  console.log(`Pack pronto: ${pack.title} (${pack.pageCount} atividades).`);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => mongoose.connection.close());
