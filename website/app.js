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

const caseTabs = [...(document.querySelectorAll?.('[role="tab"]') ?? [])];

function selectCase(nextTab) {
  for (const tab of caseTabs) {
    const isSelected = tab === nextTab;
    tab.setAttribute("aria-selected", String(isSelected));
    tab.tabIndex = isSelected ? 0 : -1;
    const panel = document.querySelector(`#${tab.getAttribute("aria-controls")}`);
    panel?.classList.toggle("is-active", isSelected);
  }
}

for (const [index, tab] of caseTabs.entries()) {
  tab.addEventListener("click", () => selectCase(tab));
  tab.addEventListener("keydown", (event) => {
    let nextIndex = index;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % caseTabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + caseTabs.length) % caseTabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = caseTabs.length - 1;
    else return;
    event.preventDefault();
    selectCase(caseTabs[nextIndex]);
    caseTabs[nextIndex].focus();
  });
}
