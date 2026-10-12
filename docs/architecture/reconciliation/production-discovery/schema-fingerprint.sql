with s as (select nspname from pg_namespace where nspname in ('ai_decision_intelligence','api','approved_business_action','audit','billing','business_digital_twin','business_intelligence','business_operations','continuous_learning','data_acquisition','events','files','identity','observability','onboarding','outcome_monitoring','platform','simulation','tenancy','public'))
select sch, kind, count(*) n, md5(string_agg(txt, '|' order by txt)) h from (
 select n.nspname sch, 'columns' kind, c.relname||'.'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),'')||':'||a.attgenerated::text txt
   from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
   where n.nspname in (select nspname from s) and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped
 union all select n.nspname, 'constraints', c.relname||'.'||co.conname||':'||pg_get_constraintdef(co.oid) from pg_constraint co join pg_class c on c.oid=co.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in (select nspname from s)
 union all select schemaname, 'indexes', tablename||'.'||indexname||':'||indexdef from pg_indexes where schemaname in (select nspname from s)
 union all select n.nspname, 'triggers', c.relname||'.'||t.tgname||':'||pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname in (select nspname from s)
 union all select n.nspname, 'functions', p.proname||'('||pg_get_function_identity_arguments(p.oid)||'):'||p.prosecdef||':'||md5(p.prosrc)||':'||coalesce(p.proconfig::text,'') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in (select nspname from s)
 union all select n.nspname, 'rls', c.relname||':'||c.relrowsecurity||':'||c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and n.nspname in (select nspname from s)
 union all select schemaname, 'policies', tablename||'.'||policyname||':'||cmd||':'||coalesce(qual,'')||':'||coalesce(with_check,'')||':'||roles::text from pg_policies where schemaname in (select nspname from s)
) x group by 1,2 order by 1,2
