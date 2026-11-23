export const DESCRIPTION =
  'Rewrite one cell of a Jupyter notebook.'
export const PROMPT = `Edits one cell of a .ipynb notebook by its id: replace swaps the cell's source for new_source, insert adds a new cell after cell_id (at the start when none is given), delete removes the cell.`
