-- 0093_employee_photo.sql — 🖼️ صورة الموظف
-- `frmEmployees.xaml` L195 `imgPersonal` + `btnImgAdd`/`btnImgDelete` keeps a file path in `Employees.PhotoPath`.
-- The cloud keeps it as a file row; `photo_file_id` points at `files.id`.
-- The column is nullable so existing rows stay valid, and no FK to `files` is added — the file
-- can be deleted independently (orphan GC), and the employee keeps its last known id until replaced.

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS photo_file_id uuid;

-- index for the join that shows the photo in the list — `employees` → `files`
CREATE INDEX IF NOT EXISTS employees_photo_file_idx ON employees (tenant_id, photo_file_id) WHERE photo_file_id IS NOT NULL;
