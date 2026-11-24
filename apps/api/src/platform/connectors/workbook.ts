import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { normalizeText } from './normalize';

export type FileFormat = 'xlsx' | 'csv';

/** A cell after reading: formulas resolved, rich text flattened, empty cells absent. */
export type CellValue = string | number | boolean | Date;

export interface SheetRow {
  /** 1-based row number as the user sees it in Excel. */
  rowNumber: number;
  cells: Record<string, CellValue>;
}

export interface Sheet {
  name: string;
  /** Normalized header texts of the first non-empty row, in column order. */
  headers: string[];
  rows: SheetRow[];
}

export class WorkbookError extends Error {}

export function detectFormat(fileName: string): FileFormat {
  const extension = fileName.toLowerCase().split('.').pop();
  if (extension === 'xlsx') return 'xlsx';
  if (extension === 'csv') return 'csv';
  throw new WorkbookError(
    `Unsupported file type ".${extension ?? ''}": use .xlsx or .csv (save .xls as .xlsx)`,
  );
}

function cellValue(raw: ExcelJS.CellValue): CellValue | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'string') return raw.trim() === '' ? undefined : raw;
  if (typeof raw === 'number' || typeof raw === 'boolean' || raw instanceof Date) return raw;
  if (typeof raw === 'object') {
    if ('richText' in raw) return cellValue(raw.richText.map((part) => part.text).join(''));
    if ('formula' in raw || 'sharedFormula' in raw) {
      return cellValue((raw as { result?: ExcelJS.CellValue }).result ?? null);
    }
    if ('text' in raw && typeof raw.text === 'string') return cellValue(raw.text);
    if ('error' in raw) return undefined;
  }
  return undefined;
}

function readSheet(worksheet: ExcelJS.Worksheet, maxRows: number): Sheet {
  let headers: string[] | null = null;
  const columns: { index: number; header: string }[] = [];
  const rows: SheetRow[] = [];

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (!headers) {
      headers = [];
      row.eachCell({ includeEmpty: false }, (cell, column) => {
        const value = cellValue(cell.value);
        if (value === undefined) return;
        const header = normalizeText(String(value)).replace(/^﻿/, '');
        if (columns.some((c) => c.header === header)) {
          throw new WorkbookError(`Sheet "${worksheet.name}" has the column "${header}" twice`);
        }
        columns.push({ index: column, header });
        headers?.push(header);
      });
      return;
    }
    const cells: Record<string, CellValue> = {};
    for (const { index, header } of columns) {
      const value = cellValue(row.getCell(index).value);
      if (value !== undefined) cells[header] = value;
    }
    if (Object.keys(cells).length === 0) return;
    rows.push({ rowNumber, cells });
    if (rows.length > maxRows) {
      throw new WorkbookError(`Sheet "${worksheet.name}" has more than ${maxRows} rows`);
    }
  });
  return { name: normalizeText(worksheet.name), headers: headers ?? [], rows };
}

/** Reads all sheets (one for CSV). Throws WorkbookError for a file people can fix. */
export async function readWorkbook(
  buffer: Buffer,
  format: FileFormat,
  maxRows: number,
): Promise<Sheet[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    if (format === 'xlsx') {
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    } else {
      // UTF-8 only; a BOM is tolerated. Cells stay text: parsing is the target field's job.
      const text = buffer.toString('utf8').replace(/^﻿/, '');
      await workbook.csv.read(Readable.from([text]), {
        sheetName: 'csv',
        parserOptions: { trim: false },
        map: (value: string) => value,
      } as never);
    }
  } catch (error) {
    if (error instanceof WorkbookError) throw error;
    throw new WorkbookError(
      `The file could not be read as ${format}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const sheets = workbook.worksheets.map((ws) => readSheet(ws, maxRows));
  const total = sheets.reduce((sum, s) => sum + s.rows.length, 0);
  if (total > maxRows)
    throw new WorkbookError(`The file has ${total} rows; the limit is ${maxRows}`);
  return sheets.filter((s) => s.headers.length > 0);
}
