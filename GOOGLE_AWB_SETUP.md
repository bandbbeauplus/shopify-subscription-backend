# Google Drive and Sheets setup for SPX AWBs

Use a Google account owned by the client. The app does not need the account
password; it uses a restricted service account.

1. Open Google Cloud Console and create or select the client's project.
2. In **APIs & Services → Library**, enable **Google Drive API** and
   **Google Sheets API**.
3. In **IAM & Admin → Service Accounts**, create a service account such as
   `spx-awb-uploader`.
4. Open that service account, choose **Keys → Add key → Create new key → JSON**,
   and download the file once. Keep it outside the repository.
5. In Google Drive, create a Shared Drive or private folder for AWB PDFs. A
   Shared Drive is preferred for company ownership. Copy the folder ID from
   `https://drive.google.com/drive/folders/FOLDER_ID`.
6. Create a spreadsheet and an empty tab named `AWB Monitoring`. Copy the sheet
   ID from `https://docs.google.com/spreadsheets/d/SHEET_ID/edit`. Keep columns
   A-K available; the app creates the header row automatically.
7. Share the folder/Shared Drive and spreadsheet with the service account's
   `client_email`. Give it permission to create files and edit the sheet. Share
   the final folder and sheet with Ninja Van only through approved accounts.
8. Convert the downloaded JSON to base64 in PowerShell:

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\secure\service-account.json"))
   ```

9. Add these private environment values to the hosted backend (for example,
   Render), not to Git and not to the frontend:

   ```text
   GOOGLE_AWB_MODE=api
   GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=<complete base64 output>
   GOOGLE_DRIVE_FOLDER_ID=<folder ID>
   GOOGLE_SHEET_ID=<spreadsheet ID>
   GOOGLE_SHEET_TAB=AWB Monitoring
   ```

10. Redeploy the backend. After an SPX UAT AWB is ready, use **Sync AWB to
    Google** once and verify the PDF, Sheet row, and warehouse access.

The monitoring sheet excludes customer names, phone numbers, and addresses.
Rotate/delete the service-account key immediately if it is exposed.
