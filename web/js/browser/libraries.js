// Populates the top-bar library <select>. Hidden entirely when there is only
// one library (nothing to choose).

export function renderLibraryPicker(selectEl, libraries, currentId, onChange) {
  selectEl.innerHTML = "";
  for (const lib of libraries) {
    const opt = document.createElement("option");
    opt.value = lib.id;
    opt.textContent = lib.name;
    if (lib.id === currentId) opt.selected = true;
    selectEl.appendChild(opt);
  }
  selectEl.hidden = libraries.length <= 1;
  selectEl.onchange = () => onChange(selectEl.value);
}
