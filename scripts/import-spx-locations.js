// Regenerate the checked-in live location snapshot when SPX provides a new workbook.
// Usage: node scripts/import-spx-locations.js "path/to/basic_location.xlsx"
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

const input = process.argv[2];
if (!input) {
  console.error('Pass the SPX basic-location .xlsx path.');
  process.exit(1);
}

async function main() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(input);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('SPX workbook has no worksheet');
  const expected = ['State', 'City', 'District', 'Street', 'Support Pickup', 'Support COD Pickup', 'Support Deliver'];
  const actual = expected.map((_, i) => String(sheet.getRow(1).getCell(i + 5).value || '').trim());
  if (actual.some((value, i) => value !== expected[i])) {
    throw new Error(`Unexpected SPX location columns: ${actual.join(', ')}`);
  }

  const locations = [];
  const seen = new Set();
  sheet.eachRow((row, number) => {
    if (number === 1) return;
    const parts = [5, 6, 7, 8].map((column) => String(row.getCell(column).value || '').trim());
    if (parts.some((value) => !value)) throw new Error(`Missing location hierarchy at row ${number}`);
    const pickupFlag = String(row.getCell(9).value ?? '').trim();
    const deliverFlag = String(row.getCell(11).value ?? '').trim();
    if (!['0', '1'].includes(pickupFlag)) throw new Error(`Invalid Support Pickup flag at row ${number}`);
    if (!['0', '1'].includes(deliverFlag)) throw new Error(`Invalid Support Deliver flag at row ${number}`);
    const pickup = pickupFlag === '1';
    const deliver = deliverFlag === '1';
    if (!pickup && !deliver) return;
    const key = JSON.stringify(parts);
    if (seen.has(key)) throw new Error(`Duplicate SPX location at row ${number}`);
    seen.add(key);
    locations.push([...parts, pickup ? 1 : 0, deliver ? 1 : 0]);
  });
  if (locations.length < 10000) throw new Error('SPX location import is unexpectedly small');
  const output = path.join(__dirname, '..', 'src', 'data', 'spxLocations.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ source: path.basename(input), locations }) + '\n');
  console.log(`Imported ${locations.length} SPX locations to ${output}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
