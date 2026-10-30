const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ExcelJS = require('exceljs');

async function tryImport(values) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spx-location-test-'));
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('sheet1');
    ['State', 'City', 'District', 'Street', 'Support Pickup', 'Support COD Pickup', 'Support Deliver']
      .forEach((header, index) => { sheet.getRow(1).getCell(index + 5).value = header; });
    values.forEach((value, index) => { sheet.getRow(2).getCell(index + 5).value = value; });
    const input = path.join(directory, 'locations.xlsx');
    await workbook.xlsx.writeFile(input);
    return spawnSync(process.execPath, [path.join(__dirname, 'import-spx-locations.js'), input], {
      encoding: 'utf8',
    });
  } finally {
    if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      throw new Error('Refusing to remove a temporary directory outside the system temp folder');
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('import rejects a serviceability flag other than zero or one', async () => {
  const result = await tryImport(['Metro Manila', 'Metro Manila', 'Taguig City', 'Fort Bonifacio', 'yes', 0, 1]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid support pickup flag at row 2/i);
});

test('import rejects a location row missing one of the four hierarchy layers', async () => {
  const result = await tryImport(['Metro Manila', 'Metro Manila', '', 'Fort Bonifacio', 1, 0, 1]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing location hierarchy at row 2/i);
});
