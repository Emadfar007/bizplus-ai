Option Explicit
Dim files, shell, project, nodePath, candidate, command, result, errorPath, errorText, reader
Set files = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
project = files.GetParentFolderName(WScript.ScriptFullName)
nodePath = ""
For Each candidate In Array(shell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe"), shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe"), shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%\nodejs\node.exe"))
  If files.FileExists(candidate) Then
    nodePath = candidate
    Exit For
  End If
Next
If nodePath = "" Then
  MsgBox "BizPlus AI needs Node.js 24. Install Node.js 24, then open this shortcut again.", vbExclamation, "BizPlus AI"
  WScript.Quit 1
End If
shell.CurrentDirectory = project
command = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & files.BuildPath(project, "scripts\launch-app.mjs") & Chr(34)
On Error Resume Next
result = shell.Run(command, 0, True)
If Err.Number <> 0 Then
  MsgBox "BizPlus AI could not open its launcher. Check that the project folder still exists.", vbExclamation, "BizPlus AI"
  WScript.Quit 1
End If
On Error GoTo 0
If result <> 0 Then
  errorText = "The local engine could not start. Check .local\app-launch.log in the project folder."
  errorPath = files.BuildPath(project, ".local\app-launch-error.txt")
  If files.FileExists(errorPath) Then
    Set reader = files.OpenTextFile(errorPath, 1)
    If Not reader.AtEndOfStream Then errorText = reader.ReadAll
    reader.Close
  End If
  MsgBox errorText, vbExclamation, "BizPlus AI"
End If
WScript.Quit result
