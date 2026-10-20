'use strict';
const express = require('express');
const db = require('../db');
const apply = require('../apply');
const v = require('../validate');
const { requireRole } = require('../auth');

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function audit(c, req, action, entity, entityId, detail) {
  await c.query('INSERT INTO audit_log (user_id, username, ip, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [req.user?.id ?? null, req.user?.username ?? null, req.ip, action, entity, entityId == null ? null : String(entityId), detail ? JSON.stringify(detail) : null]);
}

/** Telefonie-relevante Aenderung: DB + Konfiguration atomar. */
const mutate = (req, reason, fn) => apply.transact({ user: req.user.username, reason }, fn);
/** Aenderung ohne Telefoniekonfiguration. */
const plain = (fn) => db.tx(fn);

const nullIfEmpty = (x) => (x === undefined || x === null || x === '' ? null : x);

/**
 * Generische CRUD-Route.
 * spec: { path, table, entity, read, write, telephony, order, fields(merged, existing, client) -> Spalten, out(row) }
 */
function crud(router, spec) {
  const { path, table, entity, read = 'operator', write = 'operator', telephony = true, order = 'id', out = (r) => r } = spec;
  const run = (req, reason, fn) => (telephony ? mutate(req, reason, fn) : plain(fn));

  router.get(path, requireRole(read), h(async (req, res) => {
    const rows = (await db.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows;
    res.json(await Promise.all(rows.map((r) => out(r, req))));
  }));

  router.post(path, requireRole(write), h(async (req, res) => {
    const row = await run(req, `${entity} anlegen`, async (c) => {
      const vals = await spec.fields(req.body || {}, null, c);
      const cols = Object.keys(vals);
      const r = await c.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, cols.map((k) => vals[k]));
      await audit(c, req, 'create', entity, r.rows[0].id, spec.auditDetail ? spec.auditDetail(r.rows[0]) : undefined);
      return r.rows[0];
    });
    res.status(201).json(await out(row, req));
  }));

  router.put(`${path}/:id(\\d+)`, requireRole(write), h(async (req, res) => {
    const row = await run(req, `${entity} aendern`, async (c) => {
      const ex = (await c.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!ex) { const e = new Error(`${entity} nicht gefunden`); e.status = 404; throw e; }
      const vals = await spec.fields({ ...ex, ...(req.body || {}) }, ex, c);
      const cols = Object.keys(vals);
      const r = await c.query(`UPDATE ${table} SET ${cols.map((k, i) => `${k} = $${i + 1}`).join(',')} WHERE id = $${cols.length + 1} RETURNING *`, [...cols.map((k) => vals[k]), req.params.id]);
      await audit(c, req, 'update', entity, req.params.id, spec.auditDetail ? spec.auditDetail(r.rows[0]) : undefined);
      return r.rows[0];
    });
    res.json(await out(row, req));
  }));

  router.delete(`${path}/:id(\\d+)`, requireRole(write), h(async (req, res) => {
    await run(req, `${entity} loeschen`, async (c) => {
      const r = await c.query(`DELETE FROM ${table} WHERE id = $1 RETURNING *`, [req.params.id]);
      if (!r.rows[0]) { const e = new Error(`${entity} nicht gefunden`); e.status = 404; throw e; }
      if (spec.afterDelete) await spec.afterDelete(r.rows[0], c);
      await audit(c, req, 'delete', entity, req.params.id, spec.auditDetail ? spec.auditDetail(r.rows[0]) : undefined);
    });
    res.json({ ok: true });
  }));
}

/** Ziel-Syntax: hangup | <Rufnummer> | vm:<Nebenstelle> */
const dest = (field, val) => {
  const s = val === undefined || val === null || val === '' ? 'hangup' : String(val);
  if (s === 'hangup' || /^[0-9]{2,6}$/.test(s) || /^vm:[0-9]{2,6}$/.test(s)) return s;
  throw new v.ValidationError(`${field}: ungueltiges Ziel`, field);
};
const numberList = (field, val) => {
  if (!Array.isArray(val)) throw new v.ValidationError(`${field}: Liste erforderlich`, field);
  const out = [...new Set(val.map((x) => v.number(field, String(x))))];
  return out;
};

module.exports = { express, h, audit, mutate, plain, crud, dest, numberList, nullIfEmpty, v };
