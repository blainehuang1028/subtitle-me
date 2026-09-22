const command = document.querySelector("#command");
const status = document.querySelector("#copy-status");
const copyButton = document.querySelector("#copy");

copyButton?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(command.textContent);
    status.textContent = "已复制，粘贴到终端即可安装。";
  } catch {
    status.textContent = "未能访问剪贴板，请选中命令手动复制。";
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(command);
    selection.removeAllRanges();
    selection.addRange(range);
  }
});
