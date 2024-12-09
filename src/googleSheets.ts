import logger from './logger';
import type { CsvRow } from './types';

async function checkGoogleSheetAccess(url: string) {
  try {
    const response = await fetch(url);
    if (response.ok) {
      return { public: true, status: response.status };
    } else {
      return { public: false, status: response.status };
    }
  } catch (error) {
    logger.error('Error checking sheet access:', error);
    return { public: false };
  }
}

export async function fetchCsvFromGoogleSheetUnauthenticated(url: string): Promise<CsvRow[]> {
  const { parse: parseCsv } = await import('csv-parse/sync');
  const { fetchWithProxy } = await import('./fetch');

  const gid = new URL(url).searchParams.get('gid');
  const csvUrl = `${url.replace(/\/edit.*$/, '/export')}?format=csv${gid ? `&gid=${gid}` : ''}`;

  const response = await fetchWithProxy(csvUrl);
  if (response.status !== 200) {
    throw new Error(`Failed to fetch CSV from Google Sheets URL: ${url}`);
  }
  const csvData = await response.text();
  return parseCsv(csvData, { columns: true });
}

export async function fetchCsvFromGoogleSheetAuthenticated(url: string): Promise<CsvRow[]> {
  const { sheets: googleSheets, auth: googleAuth } = await import('@googleapis/sheets');
  const auth = new googleAuth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = googleSheets('v4');

  const match = url.match(/\/d\/([^/]+)/);
  if (!match) {
    throw new Error(`Invalid Google Sheets URL: ${url}`);
  }
  const spreadsheetId = match[1];

  let range = 'A1:ZZZ';
  const gid = Number(new URL(url).searchParams.get('gid'));
  if (gid) {
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId, auth });
    const sheetName = spreadsheet.data.sheets?.find((sheet) => sheet.properties?.sheetId === gid)
      ?.properties?.title;
    if (!sheetName) {
      throw new Error(`Sheet not found for gid: ${gid}`);
    }
    range = `${sheetName}!${range}`;
  }
  const response = await sheets.spreadsheets.values.get({ spreadsheetId, range, auth });

  const rows = response.data.values;
  if (!rows?.length) {
    throw new Error(`No data found in Google Sheets URL: ${url}`);
  }

  // Assuming the first row contains headers
  const headers = rows[0];
  const dataRows = rows.slice(1);

  return dataRows.map((row) => {
    const csvRow: CsvRow = {};
    headers.forEach((header, index) => {
      csvRow[header] = row[index];
    });
    return csvRow;
  });
}

export async function fetchCsvFromGoogleSheet(url: string): Promise<CsvRow[]> {
  const { public: isPublic } = await checkGoogleSheetAccess(url);
  logger.debug(`Google Sheets URL: ${url}, isPublic: ${isPublic}`);
  if (isPublic) {
    return fetchCsvFromGoogleSheetUnauthenticated(url);
  }
  return fetchCsvFromGoogleSheetAuthenticated(url);
}

export async function writeCsvToGoogleSheet(rows: CsvRow[], url: string): Promise<void> {
  const { sheets: googleSheets, auth: googleAuth } = await import('@googleapis/sheets');
  const auth = new googleAuth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = googleSheets('v4');

  const match = url.match(/\/d\/([^/]+)/);
  if (!match) {
    throw new Error(`Invalid Google Sheets URL: ${url}`);
  }
  const spreadsheetId = match[1];
  const gid = new URL(url).searchParams.get('gid');

  let range = 'A1:ZZZ';
  let sheetId = gid ? Number(gid) : null;

  if (!sheetId) {
    // Create a new sheet if no gid is provided
    const newSheetResponse = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      auth,
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: {
                title: `Sheet${Date.now()}`,
              },
            },
          },
        ],
      },
    });

    sheetId = newSheetResponse.data.replies?.[0]?.addSheet?.properties?.sheetId;
    if (!sheetId) {
      throw new Error('Failed to create a new sheet');
    }
  }

  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId, auth });
  const sheetName = spreadsheet.data.sheets?.find((sheet) => sheet.properties?.sheetId === sheetId)
    ?.properties?.title;
  if (!sheetName) {
    throw new Error(`Sheet not found for sheetId: ${sheetId}`);
  }
  range = `${sheetName}!${range}`;

  // Extract headers from the first row
  const headers = Object.keys(rows[0]);

  // Convert rows to a 2D array
  const values = [headers, ...rows.map((row) => headers.map((header) => row[header]))];

  // Write data to the sheet
  logger.debug(`Writing CSV to Google Sheets URL: ${url} with ${values.length} rows`);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    auth,
    requestBody: {
      values,
    },
  });
}
