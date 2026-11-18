-- VELOR4 Stage 2A: product management. Run this whole file once in Supabase > SQL Editor.
-- Safe to run again: it only adds what is missing.

alter table public.products
  add column if not exists sku text,
  add column if not exists subcategory text,
  add column if not exists description text,
  add column if not exists specs jsonb not null default '[]',
  add column if not exists material text,
  add column if not exists audience text,
  add column if not exists tags text[] not null default '{}',
  add column if not exists delivery_estimate text,
  add column if not exists return_days int not null default 7,
  add column if not exists featured boolean not null default false,
  add column if not exists status text not null default 'active',
  add column if not exists updated_at timestamptz default now();

do $$ begin
  alter table public.products add constraint products_status_check check (status in ('draft','active','out_of_stock'));
exception when duplicate_object then null; end $$;

-- existing products keep working: active ones stay active, hidden ones become drafts
update public.products set status = case when active then 'active' else 'draft' end where status = 'active' and active = false;
update public.products set sku = 'VEL-' || id where sku is null;
create unique index if not exists products_sku_key on public.products(sku) where sku is not null;

-- keep the old "active" column in step with status (the order function still uses it,
-- so out-of-stock and draft products can not be ordered)
create or replace function public.products_sync() returns trigger language plpgsql as $$
begin
  new.active := (new.status = 'active');
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists products_sync_trg on public.products;
create trigger products_sync_trg before insert or update on public.products
  for each row execute function public.products_sync();
update public.products set status = status;

-- supplier cost lives in its own table so customers can never read it
create table if not exists public.product_costs (
  product_id bigint primary key references public.products(id) on delete cascade,
  supplier_cost int check (supplier_cost >= 0)
);

create table if not exists public.product_images (
  id bigint generated always as identity primary key,
  product_id bigint not null references public.products(id) on delete cascade,
  url text not null,
  position int not null default 0,
  is_main boolean not null default false
);

create table if not exists public.product_variants (
  id bigint generated always as identity primary key,
  product_id bigint not null references public.products(id) on delete cascade,
  sku text,
  colour text,
  size text,
  stock int not null default 0 check (stock >= 0),
  price int check (price is null or price > 0),
  active boolean not null default true
);
create index if not exists product_images_pid on public.product_images(product_id);
create index if not exists product_variants_pid on public.product_variants(product_id);

alter table public.product_costs enable row level security;
alter table public.product_images enable row level security;
alter table public.product_variants enable row level security;

drop policy if exists "anyone reads active products" on public.products;
drop policy if exists "public reads shown products" on public.products;
create policy "public reads shown products" on public.products
  for select using (status in ('active','out_of_stock') or public.is_admin());

drop policy if exists "sellers only costs" on public.product_costs;
create policy "sellers only costs" on public.product_costs for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "read images of shown products" on public.product_images;
create policy "read images of shown products" on public.product_images for select using (
  exists (select 1 from public.products p where p.id = product_id
          and (p.status in ('active','out_of_stock') or public.is_admin())));
drop policy if exists "sellers write images" on public.product_images;
create policy "sellers write images" on public.product_images for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "read variants of shown products" on public.product_variants;
create policy "read variants of shown products" on public.product_variants for select using (
  exists (select 1 from public.products p where p.id = product_id
          and (p.status in ('active','out_of_stock') or public.is_admin())));
drop policy if exists "sellers write variants" on public.product_variants;
create policy "sellers write variants" on public.product_variants for all
  using (public.is_admin()) with check (public.is_admin());

-- One safe save for everything about a product (product, cost, photos, variants) in a single step.
create or replace function public.admin_save_product(p jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  pid bigint; st text; ids bigint[]; v jsonb; im jsonb; n int := 0; main_url text; szs text[];
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  st := coalesce(p->>'status', 'draft');
  if st not in ('draft','active','out_of_stock') then raise exception 'bad status'; end if;
  if coalesce((p->>'price')::int, 0) <= 0 then raise exception 'price must be above 0'; end if;
  if (p->>'mrp')::int < (p->>'price')::int then raise exception 'MRP must not be lower than the selling price'; end if;
  if st = 'active' and jsonb_array_length(coalesce(p->'images','[]')) = 0 then
    raise exception 'add at least one photo before publishing';
  end if;

  select im2->>'url' into main_url from jsonb_array_elements(coalesce(p->'images','[]')) im2
    order by (im2->>'is_main')::boolean desc nulls last limit 1;

  if p->>'id' is null then
    insert into products(brand,name,category,price,mrp,status) values
      (p->>'brand', p->>'name', p->>'category', (p->>'price')::int, (p->>'mrp')::int, st)
    returning id into pid;
  else
    pid := (p->>'id')::bigint;
    if not exists (select 1 from products where id = pid) then raise exception 'product not found'; end if;
  end if;

  update products set
    brand = p->>'brand', name = p->>'name', category = p->>'category',
    subcategory = nullif(p->>'subcategory',''), description = nullif(p->>'description',''),
    specs = coalesce(p->'specs','[]'), material = nullif(p->>'material',''), audience = nullif(p->>'audience',''),
    tags = coalesce(array(select jsonb_array_elements_text(coalesce(p->'tags','[]'))), '{}'),
    delivery_estimate = nullif(p->>'delivery_estimate',''),
    return_days = coalesce((p->>'return_days')::int, 0),
    featured = coalesce((p->>'featured')::boolean, false),
    price = (p->>'price')::int, mrp = (p->>'mrp')::int, status = st,
    sku = coalesce(nullif(p->>'sku',''), 'VEL-' || pid),
    image_url = main_url
  where id = pid;

  insert into product_costs(product_id, supplier_cost) values (pid, nullif(p->>'supplier_cost','')::int)
    on conflict (product_id) do update set supplier_cost = excluded.supplier_cost;

  delete from product_images where product_id = pid;
  for im in select * from jsonb_array_elements(coalesce(p->'images','[]')) loop
    insert into product_images(product_id, url, position, is_main)
      values (pid, im->>'url', n, coalesce((im->>'is_main')::boolean, false));
    n := n + 1;
  end loop;

  select coalesce(array_agg((x->>'id')::bigint), '{}') into ids
    from jsonb_array_elements(coalesce(p->'variants','[]')) x where x->>'id' is not null;
  delete from product_variants where product_id = pid and id <> all(ids);
  for v in select * from jsonb_array_elements(coalesce(p->'variants','[]')) loop
    if v->>'id' is not null then
      update product_variants set colour = nullif(v->>'colour',''), size = nullif(v->>'size',''),
        sku = nullif(v->>'sku',''), stock = coalesce((v->>'stock')::int, 0),
        price = nullif(v->>'price','')::int, active = coalesce((v->>'active')::boolean, true)
        where id = (v->>'id')::bigint and product_id = pid;
    else
      insert into product_variants(product_id, colour, size, sku, stock, price, active)
        values (pid, nullif(v->>'colour',''), nullif(v->>'size',''), nullif(v->>'sku',''),
                coalesce((v->>'stock')::int, 0), nullif(v->>'price','')::int, coalesce((v->>'active')::boolean, true));
    end if;
  end loop;

  select coalesce(array_agg(distinct size), '{}') into szs from product_variants
    where product_id = pid and active and stock > 0 and size is not null;
  update products set sizes = nullif(szs, '{}') where id = pid;
  return pid;
end $$;

revoke all on function public.admin_save_product(jsonb) from public, anon;
grant execute on function public.admin_save_product(jsonb) to authenticated;
