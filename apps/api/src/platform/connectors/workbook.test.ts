import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { detectFormat, readWorkbook, WorkbookError } from './workbook';

async function xlsx(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('readWorkbook', () => {
  it('reads every sheet: headers, typed cells, formulas and rich text', async () => {
    const buffer = await xlsx((wb) => {
      const ws = wb.addWorksheet('واحدها');
      ws.addRow(['کد', 'نام', 'تاریخ', 'مبلغ']);
      ws.addRow([
        'U1',
        { richText: [{ text: 'مدیریت ' }, { text: 'مالي' }] },
        new Date(Date.UTC(2026, 10, 22)),
        { formula: '1+1', result: 2 },
      ]);
      ws.addRow([]);
      ws.addRow(['U2', 'فروش', '1405/09/01', 5]);
      wb.addWorksheet('خالی');
    });
    const sheets = await readWorkbook(buffer, 'xlsx', 100);
    expect(sheets).toHaveLength(1);
    const [sheet] = sheets;
    expect(sheet?.headers).toEqual(['کد', 'نام', 'تاریخ', 'مبلغ']);
    expect(sheet?.rows.map((r) => r.rowNumber)).toEqual([2, 4]);
    expect(sheet?.rows[0]?.cells).toEqual({
      کد: 'U1',
      نام: 'مدیریت مالي',
      تاریخ: new Date(Date.UTC(2026, 10, 22)),
      مبلغ: 2,
    });
  });

  it('reads UTF-8 CSV with a BOM as one sheet of text cells', async () => {
    const csv = Buffer.from('﻿کد,نام\nU1,"واحد ۱"\nU2,دوم\n', 'utf8');
    const [sheet] = await readWorkbook(csv, 'csv', 100);
    expect(sheet?.headers).toEqual(['کد', 'نام']);
    expect(sheet?.rows.map((r) => r.cells)).toEqual([
      { کد: 'U1', نام: 'واحد ۱' },
      { کد: 'U2', نام: 'دوم' },
    ]);
  });

  it('enforces the row limit and duplicate headers', async () => {
    const many = await xlsx((wb) => {
      const ws = wb.addWorksheet('s');
      ws.addRow(['a']);
      for (let i = 0; i < 5; i += 1) ws.addRow([i + 1]);
    });
    await expect(readWorkbook(many, 'xlsx', 3)).rejects.toThrow('more than 3 rows');
    const dup = await xlsx((wb) => wb.addWorksheet('s').addRow(['کد', 'کد']));
    await expect(readWorkbook(dup, 'xlsx', 10)).rejects.toThrow('twice');
  });

  it('rejects files that are not what they claim', async () => {
    await expect(readWorkbook(Buffer.from('not a zip'), 'xlsx', 10)).rejects.toBeInstanceOf(
      WorkbookError,
    );
    expect(() => detectFormat('old.xls')).toThrow('save .xls as .xlsx');
    expect(detectFormat('Data.XLSX')).toBe('xlsx');
  });
});
