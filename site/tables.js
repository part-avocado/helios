// Tables with more columns than a phone has room for. Below 640px a
// table.data.stack stops being a grid: each row is a card, its first cell the
// title and the others named values (style.css). labelCells gives every cell
// its column's name, from the table's header row, for the card to print.
// Call it after writing a table's rows.
function labelCells(scope = document) {
	for (const table of scope.querySelectorAll('table.data.stack')) {
		const names = [...(table.rows[0]?.cells ?? [])].map((th) => th.textContent.trim())
		for (const row of table.rows) {
			for (const cell of row.cells) if (cell.tagName === 'TD') cell.dataset.label = names[cell.cellIndex] ?? ''
		}
	}
}
