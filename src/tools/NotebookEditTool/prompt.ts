export const DESCRIPTION =
  'Rewrite one cell of a Jupyter notebook.'
export const PROMPT = `Swaps one notebook cell's source for the content you pass (.ipynb files). cell_number counts from 0. edit_mode=insert plants a fresh cell at the cell_number index; edit_mode=delete removes the cell sitting there.`
