# Converts a .docx to .pdf with Microsoft Word (used by build_report.py).
param([Parameter(Mandatory = $true)][string]$In, [Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open((Resolve-Path $In).Path, $false, $true)
  $doc.Fields.Update() | Out-Null
  $doc.ExportAsFixedFormat($Out, 17)  # wdExportFormatPDF
  $doc.Close($false)
} finally {
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}
