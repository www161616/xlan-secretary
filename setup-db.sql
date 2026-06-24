-- 待辦事項
CREATE TABLE IF NOT EXISTS xlan_todos (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  text text NOT NULL,
  done boolean DEFAULT false,
  source_group text,
  source_message text,
  created_at timestamptz DEFAULT now(),
  done_at timestamptz
);

-- 對話記錄
CREATE TABLE IF NOT EXISTS xlan_conversations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id text NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- 記帳
CREATE TABLE IF NOT EXISTS xlan_expenses (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  amount integer NOT NULL,
  category text NOT NULL,
  note text,
  type text NOT NULL DEFAULT 'expense',
  account text NOT NULL DEFAULT 'personal',
  created_at timestamptz DEFAULT now()
);

-- 記事本
CREATE TABLE IF NOT EXISTS xlan_notes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  content text NOT NULL,
  tags text[],
  created_at timestamptz DEFAULT now()
);

-- 行程快取
CREATE TABLE IF NOT EXISTS xlan_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  title text NOT NULL,
  date text NOT NULL,
  time text,
  location text,
  description text,
  created_at timestamptz DEFAULT now()
);

-- 定期付款
CREATE TABLE IF NOT EXISTS xlan_recurring (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  title text NOT NULL,
  amount integer,
  account text NOT NULL DEFAULT 'personal',
  frequency text NOT NULL,
  day_of_month integer,
  month_of_year integer,
  note text,
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- KV 設定
CREATE TABLE IF NOT EXISTS xlan_kv (
  key text PRIMARY KEY,
  value text NOT NULL
);

-- RLS
ALTER TABLE xlan_todos ENABLE ROW LEVEL SECURITY;
ALTER TABLE xlan_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE xlan_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE xlan_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE xlan_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE xlan_recurring ENABLE ROW LEVEL SECURITY;
ALTER TABLE xlan_kv ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "anon_all_todos" ON xlan_todos FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "anon_all_conversations" ON xlan_conversations FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "anon_all_expenses" ON xlan_expenses FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "anon_all_notes" ON xlan_notes FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "anon_all_events" ON xlan_events FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "anon_all_recurring" ON xlan_recurring FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "anon_all_kv" ON xlan_kv FOR ALL USING (true) WITH CHECK (true);

-- 陸貨追蹤
CREATE TABLE IF NOT EXISTS xlan_shipments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  title text NOT NULL,
  expected_date date NOT NULL,
  status text DEFAULT 'pending',
  note text,
  arrived_at timestamptz,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE xlan_shipments ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "anon_all_shipments" ON xlan_shipments FOR ALL USING (true) WITH CHECK (true);

-- 應付款追蹤
CREATE TABLE IF NOT EXISTS xlan_payables (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  title text NOT NULL,
  amount integer,
  to_whom text,
  due_date date,
  status text DEFAULT 'pending',
  note text,
  paid_at timestamptz,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE xlan_payables ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "anon_all_payables" ON xlan_payables FOR ALL USING (true) WITH CHECK (true);

-- Bug 追蹤
CREATE TABLE IF NOT EXISTS xlan_bugs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  description text NOT NULL,
  reporter text,
  source_group text,
  status text DEFAULT 'pending',
  fixed_at timestamptz,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE xlan_bugs ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "anon_all_bugs" ON xlan_bugs FOR ALL USING (true) WITH CHECK (true);

-- 廠商資料
CREATE TABLE IF NOT EXISTS xlan_vendors (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  contact_person text,
  phone text,
  payment_terms text,
  note text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE xlan_vendors ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "anon_all_vendors" ON xlan_vendors FOR ALL USING (true) WITH CHECK (true);

-- 專案管理
CREATE TABLE IF NOT EXISTS xlan_projects (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name text NOT NULL,
  description text,
  status text DEFAULT 'active',
  created_at timestamptz DEFAULT now()
);
ALTER TABLE xlan_projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "anon_all_projects" ON xlan_projects FOR ALL USING (true) WITH CHECK (true);

-- 欄位補丁（已存在的表加欄位）
ALTER TABLE xlan_expenses ADD COLUMN IF NOT EXISTS account text NOT NULL DEFAULT 'personal';
ALTER TABLE xlan_todos ADD COLUMN IF NOT EXISTS priority text DEFAULT 'normal';
ALTER TABLE xlan_todos ADD COLUMN IF NOT EXISTS source_person text;
ALTER TABLE xlan_todos ADD COLUMN IF NOT EXISTS done_at timestamptz;
ALTER TABLE xlan_todos ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES xlan_projects(id);
ALTER TABLE xlan_todos ADD COLUMN IF NOT EXISTS project_name text;
