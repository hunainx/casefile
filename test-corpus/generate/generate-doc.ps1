# Regenerates test-corpus/legacy.doc: a synthetic Word 97-2003 (.doc) document.
# All names and addresses are fictional.
#
#   powershell -ExecutionPolicy Bypass -File test-corpus/generate/generate-doc.ps1
#
# Requires Microsoft Word on Windows (the binary .doc format is written by Word itself).
# Word's user name is swapped for a placeholder while saving and personal information
# is stripped, so the file carries no details of the machine that generated it.

$ErrorActionPreference = "Stop"
$out = Join-Path (Split-Path -Parent $PSScriptRoot) "legacy.doc"

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
$savedName = $word.UserName
$savedInitials = $word.UserInitials
try {
    $word.UserName = "Jane Doe"
    $word.UserInitials = "JD"
    $doc = $word.Documents.Add()
    $text = @(
        "ASSIGNMENT AND SUBSTITUTION OF COUNSEL",
        "",
        "Acme Holdings, LLC v. Example Corp., Case No. 00-CV-0000",
        "Superior Court of the State of Example, County of Sample",
        "",
        "The undersigned does hereby assign all rights and obligations as counsel of record for Plaintiff Acme Holdings, LLC to Doe & Roe LLP, 123 Example Street, Sampletown, EX 00000, and consents to the substitution of Doe & Roe LLP as counsel of record in place of the undersigned.",
        "",
        "The client, Acme Holdings, LLC, consents to this substitution.",
        "",
        "Dated: February 2, 2026",
        "",
        "Richard Roe, Former Counsel",
        "Jane Doe, Manager, Acme Holdings, LLC",
        "John Roe, Doe & Roe LLP, New Counsel",
        "",
        "FICTIONAL DOCUMENT FOR SOFTWARE TESTING. ALL NAMES AND FACTS ARE INVENTED."
    ) -join "`r"
    $doc.Content.Text = $text
    # A primary footer, so the parser's header/footer handling is exercised (1 = wdHeaderFooterPrimary).
    $doc.Sections.Item(1).Footers.Item(1).Range.Text = "Doe & Roe LLP - Example Footer Line"
    # BuiltInDocumentProperties does not late-bind from PowerShell; go through IDispatch.
    $props = $doc.BuiltInDocumentProperties
    $title = [System.__ComObject].InvokeMember("Item", "GetProperty", $null, $props, @("Title"))
    [System.__ComObject].InvokeMember("Value", "SetProperty", $null, $title, @("Assignment and Substitution of Counsel")) | Out-Null
    # Strips author, last-saved-by, company and similar fields on save.
    $doc.RemovePersonalInformation = $true
    # 0 = wdFormatDocument97
    $doc.SaveAs2([string]$out, 0)
    $doc.Close(0)
    Write-Output "wrote $out"
}
finally {
    $word.UserName = $savedName
    $word.UserInitials = $savedInitials
    $word.Quit([ref]0)
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}
