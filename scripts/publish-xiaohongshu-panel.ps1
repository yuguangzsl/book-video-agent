param(
  [Parameter(Mandatory = $true)]
  [string]$PayloadPath,
  [switch]$ValidateOnly,
  [switch]$SmokeTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Assert-Value {
  param(
    [bool]$Condition,
    [string]$Message
  )
  if (-not $Condition) {
    throw $Message
  }
}

$resolvedPayloadPath = [System.IO.Path]::GetFullPath($PayloadPath)
Assert-Value (Test-Path -LiteralPath $resolvedPayloadPath -PathType Leaf) "Manual publication payload is missing: $resolvedPayloadPath"
$payload = Get-Content -LiteralPath $resolvedPayloadPath -Raw -Encoding UTF8 | ConvertFrom-Json

Assert-Value ($payload.schemaVersion -eq 1) "Unsupported manual publication payload schema"
Assert-Value ($payload.platform -eq "xiaohongshu") "Manual publication payload is not for Xiaohongshu"
Assert-Value (-not [string]::IsNullOrWhiteSpace([string]$payload.title)) "Xiaohongshu title is empty"
Assert-Value (-not [string]::IsNullOrWhiteSpace([string]$payload.description)) "Xiaohongshu description is empty"
Assert-Value ($payload.hashtags.Count -ge 3 -and $payload.hashtags.Count -le 5) "Xiaohongshu requires 3-5 hashtags"
Assert-Value (Test-Path -LiteralPath ([string]$payload.videoPath) -PathType Leaf) "Release video is missing: $($payload.videoPath)"
$isTestMode = $payload.PSObject.Properties.Name -contains "testMode" -and $payload.testMode -eq $true

if ($ValidateOnly) {
  [ordered]@{
    validated = $true
    platform = $payload.platform
    book = $payload.book
    videoPath = $payload.videoPath
    hashtagCount = $payload.hashtags.Count
  } | ConvertTo-Json -Compress
  exit 0
}

Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class ManualPublisherNativeWindow
{
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

function New-Brush {
  param([string]$Color)
  return [System.Windows.Media.BrushConverter]::new().ConvertFromString($Color)
}

function New-Section {
  param([string]$Title)
  $border = [System.Windows.Controls.Border]::new()
  $border.Background = New-Brush "#FFFFFFFF"
  $border.BorderBrush = New-Brush "#FFE4E7EC"
  $border.BorderThickness = [System.Windows.Thickness]::new(1)
  $border.CornerRadius = [System.Windows.CornerRadius]::new(10)
  $border.Padding = [System.Windows.Thickness]::new(10)
  $border.Margin = [System.Windows.Thickness]::new(0, 0, 0, 8)

  $stack = [System.Windows.Controls.StackPanel]::new()
  $heading = [System.Windows.Controls.TextBlock]::new()
  $heading.Text = $Title
  $heading.FontSize = 14
  $heading.FontWeight = [System.Windows.FontWeights]::SemiBold
  $heading.Foreground = New-Brush "#FF111827"
  $heading.Margin = [System.Windows.Thickness]::new(0, 0, 0, 6)
  [void]$stack.Children.Add($heading)
  $border.Child = $stack
  return [pscustomobject]@{ Border = $border; Content = $stack }
}

function New-ActionButton {
  param(
    [string]$Text,
    [bool]$Primary = $false
  )
  $button = [System.Windows.Controls.Button]::new()
  $button.Content = $Text
  $button.MinWidth = 86
  $button.Height = 30
  $button.Padding = [System.Windows.Thickness]::new(10, 0, 10, 0)
  $button.Margin = [System.Windows.Thickness]::new(0, 0, 8, 0)
  $button.Cursor = [System.Windows.Input.Cursors]::Hand
  $button.BorderThickness = [System.Windows.Thickness]::new(1)
  if ($Primary) {
    $button.Background = New-Brush "#FFE11D48"
    $button.BorderBrush = New-Brush "#FFE11D48"
    $button.Foreground = New-Brush "#FFFFFFFF"
  }
  else {
    $button.Background = New-Brush "#FFF9FAFB"
    $button.BorderBrush = New-Brush "#FFD0D5DD"
    $button.Foreground = New-Brush "#FF344054"
  }
  return $button
}

function New-ReadOnlyTextBox {
  param(
    [string]$Text,
    [double]$Height
  )
  $box = [System.Windows.Controls.TextBox]::new()
  $box.Text = $Text
  $box.IsReadOnly = $true
  $box.TextWrapping = [System.Windows.TextWrapping]::Wrap
  $box.VerticalScrollBarVisibility = [System.Windows.Controls.ScrollBarVisibility]::Auto
  $box.BorderBrush = New-Brush "#FFD0D5DD"
  $box.Background = New-Brush "#FFF9FAFB"
  $box.Foreground = New-Brush "#FF101828"
  $box.Padding = [System.Windows.Thickness]::new(10, 8, 10, 8)
  $box.Height = $Height
  $box.FontSize = 13
  return $box
}

$window = [System.Windows.Window]::new()
$window.Title = if ($isTestMode) { "小红书面板测试（请勿发布） - $($payload.book)" } else { "小红书手动发布 - $($payload.book)" }
$window.Width = 520
$window.Height = 700
$window.MinWidth = 480
$window.MinHeight = 640
$window.Topmost = $true
$window.ShowInTaskbar = $true
$window.ResizeMode = [System.Windows.ResizeMode]::CanResizeWithGrip
$window.WindowStartupLocation = [System.Windows.WindowStartupLocation]::Manual
$window.Background = New-Brush "#FFF2F4F7"
$window.FontFamily = [System.Windows.Media.FontFamily]::new("Microsoft YaHei UI")

$root = [System.Windows.Controls.Grid]::new()
$root.RowDefinitions.Add([System.Windows.Controls.RowDefinition]::new()) | Out-Null
$root.RowDefinitions[0].Height = [System.Windows.GridLength]::Auto
$root.RowDefinitions.Add([System.Windows.Controls.RowDefinition]::new()) | Out-Null
$root.RowDefinitions[1].Height = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
$root.RowDefinitions.Add([System.Windows.Controls.RowDefinition]::new()) | Out-Null
$root.RowDefinitions[2].Height = [System.Windows.GridLength]::Auto

$header = [System.Windows.Controls.Border]::new()
$header.Background = New-Brush "#FF101828"
$header.Padding = [System.Windows.Thickness]::new(16, 10, 16, 10)
[System.Windows.Controls.Grid]::SetRow($header, 0)
$headerStack = [System.Windows.Controls.StackPanel]::new()
$headerTitle = [System.Windows.Controls.TextBlock]::new()
$headerTitle.Text = if ($isTestMode) { "小红书面板测试 · 请勿发布" } else { "小红书手动发布" }
$headerTitle.Foreground = New-Brush "#FFFFFFFF"
$headerTitle.FontSize = 17
$headerTitle.FontWeight = [System.Windows.FontWeights]::SemiBold
[void]$headerStack.Children.Add($headerTitle)
$header.Child = $headerStack
[void]$root.Children.Add($header)

$content = [System.Windows.Controls.StackPanel]::new()
$content.Margin = [System.Windows.Thickness]::new(12)
[System.Windows.Controls.Grid]::SetRow($content, 1)
[void]$root.Children.Add($content)

$videoSection = New-Section "1. 视频"
$videoDrag = [System.Windows.Controls.Border]::new()
$videoDrag.Background = New-Brush "#FFFFF1F3"
$videoDrag.BorderBrush = New-Brush "#FFFDA4AF"
$videoDrag.BorderThickness = [System.Windows.Thickness]::new(1)
$videoDrag.CornerRadius = [System.Windows.CornerRadius]::new(8)
$videoDrag.Padding = [System.Windows.Thickness]::new(10)
$videoDrag.Cursor = [System.Windows.Input.Cursors]::Hand
$videoText = [System.Windows.Controls.TextBlock]::new()
$videoText.Text = "拖动上传  ·  $($payload.videoFileName)"
$videoText.FontWeight = [System.Windows.FontWeights]::SemiBold
$videoText.Foreground = New-Brush "#FF9F1239"
$videoText.TextTrimming = [System.Windows.TextTrimming]::CharacterEllipsis
$videoDrag.Child = $videoText
[void]$videoSection.Content.Children.Add($videoDrag)

$videoButtons = [System.Windows.Controls.StackPanel]::new()
$videoButtons.Orientation = [System.Windows.Controls.Orientation]::Horizontal
$videoButtons.Margin = [System.Windows.Thickness]::new(0, 8, 0, 0)
$copyVideoPathButton = New-ActionButton "复制视频路径"
$openVideoFolderButton = New-ActionButton "打开所在位置"
[void]$videoButtons.Children.Add($copyVideoPathButton)
[void]$videoButtons.Children.Add($openVideoFolderButton)
[void]$videoSection.Content.Children.Add($videoButtons)
[void]$content.Children.Add($videoSection.Border)

$titleSection = New-Section "2. 标题"
$titleBox = New-ReadOnlyTextBox ([string]$payload.title) 52
[void]$titleSection.Content.Children.Add($titleBox)
$titleButtons = [System.Windows.Controls.StackPanel]::new()
$titleButtons.Orientation = [System.Windows.Controls.Orientation]::Horizontal
$titleButtons.Margin = [System.Windows.Thickness]::new(0, 8, 0, 0)
$inputTitleButton = New-ActionButton "输入标题" $true
$copyTitleButton = New-ActionButton "复制标题"
[void]$titleButtons.Children.Add($inputTitleButton)
[void]$titleButtons.Children.Add($copyTitleButton)
[void]$titleSection.Content.Children.Add($titleButtons)
[void]$content.Children.Add($titleSection.Border)

$descriptionSection = New-Section "3. 简介"
$descriptionBox = New-ReadOnlyTextBox ([string]$payload.description) 90
[void]$descriptionSection.Content.Children.Add($descriptionBox)
$descriptionButtons = [System.Windows.Controls.StackPanel]::new()
$descriptionButtons.Orientation = [System.Windows.Controls.Orientation]::Horizontal
$descriptionButtons.Margin = [System.Windows.Thickness]::new(0, 8, 0, 0)
$inputDescriptionButton = New-ActionButton "输入简介" $true
$copyDescriptionButton = New-ActionButton "复制简介"
[void]$descriptionButtons.Children.Add($inputDescriptionButton)
[void]$descriptionButtons.Children.Add($copyDescriptionButton)
[void]$descriptionSection.Content.Children.Add($descriptionButtons)
[void]$content.Children.Add($descriptionSection.Border)

$tagSection = New-Section "4. 标签"
$tagText = [System.Windows.Controls.TextBlock]::new()
$tagText.Text = [string]$payload.hashtagText
$tagText.TextWrapping = [System.Windows.TextWrapping]::Wrap
$tagText.Foreground = New-Brush "#FF101828"
$tagText.FontSize = 13
$tagText.Margin = [System.Windows.Thickness]::new(0, 0, 0, 8)
[void]$tagSection.Content.Children.Add($tagText)
$tagButtons = [System.Windows.Controls.StackPanel]::new()
$tagButtons.Orientation = [System.Windows.Controls.Orientation]::Horizontal
$inputTagsButton = New-ActionButton "输入并选择标签" $true
$copyTagsButton = New-ActionButton "复制标签"
[void]$tagButtons.Children.Add($inputTagsButton)
[void]$tagButtons.Children.Add($copyTagsButton)
[void]$tagSection.Content.Children.Add($tagButtons)
[void]$content.Children.Add($tagSection.Border)

$footer = [System.Windows.Controls.Border]::new()
$footer.Background = New-Brush "#FFFFFFFF"
$footer.BorderBrush = New-Brush "#FFE4E7EC"
$footer.BorderThickness = [System.Windows.Thickness]::new(0, 1, 0, 0)
$footer.Padding = [System.Windows.Thickness]::new(12, 8, 12, 8)
[System.Windows.Controls.Grid]::SetRow($footer, 2)
$footerGrid = [System.Windows.Controls.Grid]::new()
$footerGrid.ColumnDefinitions.Add([System.Windows.Controls.ColumnDefinition]::new()) | Out-Null
$footerGrid.ColumnDefinitions[0].Width = [System.Windows.GridLength]::new(1, [System.Windows.GridUnitType]::Star)
$footerGrid.ColumnDefinitions.Add([System.Windows.Controls.ColumnDefinition]::new()) | Out-Null
$footerGrid.ColumnDefinitions[1].Width = [System.Windows.GridLength]::Auto
$statusText = [System.Windows.Controls.TextBlock]::new()
$statusText.Text = if ($isTestMode) { "测试页已打开，请勿发布" } else { "发布页已用普通浏览器打开" }
$statusText.Foreground = New-Brush "#FF475467"
$statusText.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
$statusText.TextTrimming = [System.Windows.TextTrimming]::CharacterEllipsis
[System.Windows.Controls.Grid]::SetColumn($statusText, 0)
[void]$footerGrid.Children.Add($statusText)
$openPageButton = New-ActionButton "打开发布页"
$openPageButton.Margin = [System.Windows.Thickness]::new(8, 0, 0, 0)
[System.Windows.Controls.Grid]::SetColumn($openPageButton, 1)
[void]$footerGrid.Children.Add($openPageButton)
$footer.Child = $footerGrid
[void]$root.Children.Add($footer)

$window.Content = $root

function Set-Status {
  param([string]$Text)
  $statusText.Text = $Text
}

function Set-ClipboardTextWithRetry {
  param([string]$Text)
  for ($attempt = 1; $attempt -le 5; $attempt += 1) {
    try {
      [System.Windows.Clipboard]::SetText($Text)
      return $true
    }
    catch {
      if ($attempt -lt 5) {
        Start-Sleep -Milliseconds (80 * $attempt)
      }
    }
  }
  Set-Status "剪贴板暂时被占用，请稍后重试；面板会保持打开"
  return $false
}

function Open-PublishPage {
  $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $processInfo.FileName = [string]$payload.publishUrl
  $processInfo.UseShellExecute = $true
  [void][System.Diagnostics.Process]::Start($processInfo)
}

function Activate-LastExternalWindow {
  if ($script:LastExternalHandle -eq [System.IntPtr]::Zero) {
    Set-Status "未找到上一窗口：先点击小红书目标输入区，再点击输入按钮"
    return $false
  }
  $activated = [ManualPublisherNativeWindow]::SetForegroundWindow(($script:LastExternalHandle))
  if (-not $activated) {
    Set-Status "无法切回小红书窗口；内容已复制，可手动粘贴"
    return $false
  }
  Start-Sleep -Milliseconds 180
  return $true
}

function Input-TextAtCursor {
  param(
    [string]$Text,
    [string]$SuccessMessage
  )
  try {
    if (-not (Set-ClipboardTextWithRetry $Text)) {
      return
    }
    if (-not (Activate-LastExternalWindow)) {
      return
    }
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Set-Status $SuccessMessage
  }
  catch {
    Set-Status "输入失败：$($_.Exception.Message)；面板会保持打开，可改用复制后手动粘贴"
  }
}

$script:PanelHandle = [System.IntPtr]::Zero
$script:LastExternalHandle = [System.IntPtr]::Zero
$script:DragStart = $null

$window.Add_SourceInitialized({
  $helper = [System.Windows.Interop.WindowInteropHelper]::new($window)
  $script:PanelHandle = $helper.Handle
})

$foregroundTimer = [System.Windows.Threading.DispatcherTimer]::new()
$foregroundTimer.Interval = [System.TimeSpan]::FromMilliseconds(150)
$foregroundTimer.Add_Tick({
  $foreground = [ManualPublisherNativeWindow]::GetForegroundWindow()
  if ($foreground -ne [System.IntPtr]::Zero -and $foreground -ne $script:PanelHandle) {
    $script:LastExternalHandle = $foreground
  }
})
$foregroundTimer.Start()

$videoDrag.Add_PreviewMouseLeftButtonDown({
  param($sender, $eventArgs)
  $script:DragStart = $eventArgs.GetPosition($videoDrag)
})
$videoDrag.Add_PreviewMouseLeftButtonUp({
  $script:DragStart = $null
})
$videoDrag.Add_PreviewMouseMove({
  param($sender, $eventArgs)
  if ($null -eq $script:DragStart -or $eventArgs.LeftButton -ne [System.Windows.Input.MouseButtonState]::Pressed) {
    return
  }
  $current = $eventArgs.GetPosition($videoDrag)
  if ([Math]::Abs($current.X - ($script:DragStart).X) -lt 4 -and [Math]::Abs($current.Y - ($script:DragStart).Y) -lt 4) {
    return
  }
  $script:DragStart = $null
  $data = [System.Windows.DataObject]::new()
  $data.SetData([System.Windows.DataFormats]::FileDrop, [string[]]@([string]$payload.videoPath))
  [void][System.Windows.DragDrop]::DoDragDrop($videoDrag, $data, [System.Windows.DragDropEffects]::Copy)
  Set-Status "视频拖拽已完成，请检查页面上传进度"
})

$copyVideoPathButton.Add_Click({
  if (Set-ClipboardTextWithRetry ([string]$payload.videoPath)) {
    Set-Status "已复制视频路径"
  }
})
$openVideoFolderButton.Add_Click({
  $explorerArgument = '/select,"{0}"' -f [string]$payload.videoPath
  [void][System.Diagnostics.Process]::Start("explorer.exe", $explorerArgument)
  Set-Status "已打开视频所在位置"
})
$copyTitleButton.Add_Click({
  if (Set-ClipboardTextWithRetry ([string]$payload.title)) {
    Set-Status "已复制标题"
  }
})
$inputTitleButton.Add_Click({
  Input-TextAtCursor ([string]$payload.title) "已在光标处输入标题"
})
$copyDescriptionButton.Add_Click({
  if (Set-ClipboardTextWithRetry ([string]$payload.description)) {
    Set-Status "已复制简介"
  }
})
$inputDescriptionButton.Add_Click({
  Input-TextAtCursor ([string]$payload.description) "已在光标处输入简介"
})
$copyTagsButton.Add_Click({
  if (Set-ClipboardTextWithRetry ([string]$payload.hashtagText)) {
    Set-Status "已复制标签"
  }
})
$inputTagsButton.Add_Click({
  try {
    if (-not (Activate-LastExternalWindow)) {
      return
    }
    $tagIndex = 0
    foreach ($tag in $payload.hashtags) {
      $tagInput = if ($tagIndex -eq 0) { " $tag" } else { "$tag" }
      if (-not (Set-ClipboardTextWithRetry $tagInput)) {
        return
      }
      [System.Windows.Forms.SendKeys]::SendWait("^v")
      Start-Sleep -Milliseconds 900
      [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
      Start-Sleep -Milliseconds 350
      [System.Windows.Forms.SendKeys]::SendWait(" ")
      $tagIndex += 1
    }
    Set-Status "标签已逐个输入并选择第一条建议；请人工核对话题是否准确"
  }
  catch {
    Set-Status "标签输入未完成：$($_.Exception.Message)；面板会保持打开，可使用“复制标签”手动粘贴"
  }
})
$openPageButton.Add_Click({
  Open-PublishPage
  Set-Status "已打开小红书官方发布页"
})

$window.Add_Loaded({
  $workArea = [System.Windows.SystemParameters]::WorkArea
  $window.Height = [Math]::Max($window.MinHeight, [Math]::Min(700, $workArea.Height - 24))
  $window.Left = [Math]::Max($workArea.Left, $workArea.Right - $window.Width - 16)
  $window.Top = $workArea.Top + 12
  Open-PublishPage
})
$window.Add_Closed({
  $foregroundTimer.Stop()
})

if ($SmokeTest) {
  $foregroundTimer.Stop()
  [ordered]@{
    smokeTest = $true
    topmost = $window.Topmost
    title = $window.Title
    sectionCount = $content.Children.Count
  } | ConvertTo-Json -Compress
  exit 0
}

[void]$window.ShowDialog()
