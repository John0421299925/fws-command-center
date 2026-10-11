// ================================================================
// FWS Command Center — Rate card export (every service, with its client)
// Deploy as: api/rate-card-export.js
// ================================================================
// Version: v1.0
//
// PURPOSE: one file that shows the WHOLE rate card the way the invoice
// automation sees it: every service in HubSpot (the Services object) with the
// client company it is linked to, its supplier, its supplier account number,
// the supplier cost and the client price. John, 11 Oct 2026: he needs proof that
// every line James billed in Xero in July and August has a service on the right
// client, and the only way to prove it is to put the Xero lines and the rate card
// side by side. This is the rate card half. The Xero half is
// fws-xero-reader /api/invoice-lines. Run both each month and the monthly
// "things that do not add up" report can be produced from them.
//
// Read-only. Admin only (it holds supplier costs and client prices for every
// client). Includes services of EVERY status (Active, Moved to another SP...) with
// the status as a column, so a stale or lost-account service is visible too.
//
// Usage: GET /api/rate-card-export          (a CSV download)
//        GET /api/rate-card-export?format=json
// A service linked to more than one company lists all of them in Company,
// separated by " | ".
// ================================================================

import { verifySession } from '../lib/auth.js';
import { hubspotPost } from '../lib/hubspotInvoiceData.js';

const PROPERTIES = ['hs_name', 'service_status', 'service_provider', 'suppliers_account_number', 'waste_type', 'general_waste_type', 'bin_size', 'revenue_account_code',
                    'unit_cost_from_service_provider', 'unit_cost_to_client', 'bin_rental', 'client_monthly_rent', 'service_provider_monthly_rent', 'number_of_bins'];
const COLUMNS = ['ServiceID', 'ServiceName', 'Status', 'Company', 'CompanyIDs', 'Supplier', 'SupplierAccount', 'WasteType', 'GeneralWasteType', 'BinSize', 'GLCode',
                 'SupplierCost', 'ClientPrice', 'BinRental', 'ClientMonthlyRent', 'SupplierMonthlyRent', 'NumberOfBins'];

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default async function handler(req, res) {
  const session = verifySession(req);
  if (!session) {
    return res.status(401).json({ status: 'error', error: 'Not authenticated' });
  }
  if (session.role !== 'admin') {
    return res.status(403).json({ status: 'error', error: 'This view is company-wide and restricted to admin accounts' });
  }
  const format = String(req.query?.format || 'csv').toLowerCase();
  if (!['csv', 'json'].includes(format)) {
    return res.status(400).json({ status: 'error', error: 'format must be csv or json' });
  }

  try {
    // every service, any status (a search with no filter would be refused, so ask for everything that has a name)
    const services = [];
    let after;
    for (let page = 0; page < 30; page++) {
      const data = await hubspotPost('/crm/v3/objects/0-162/search', {
        limit: 100,
        after,
        properties: PROPERTIES,
        filterGroups: [{ filters: [{ propertyName: 'hs_name', operator: 'HAS_PROPERTY' }] }],
        sorts: [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }],
      });
      services.push(...(data.results || []));
      after = data.paging?.next?.after;
      if (!after) break;
    }

    // which companies each service is linked to
    const companyIdsByService = new Map();
    for (let i = 0; i < services.length; i += 100) {
      const chunk = services.slice(i, i + 100);
      const data = await hubspotPost('/crm/v4/associations/0-162/companies/batch/read', { inputs: chunk.map((s) => ({ id: String(s.id) })) });
      for (const r of data.results || []) companyIdsByService.set(String(r.from?.id), (r.to || []).map((t) => String(t.toObjectId)));
    }
    const allIds = [...new Set([...companyIdsByService.values()].flat())];
    const nameById = new Map();
    for (let i = 0; i < allIds.length; i += 100) {
      const data = await hubspotPost('/crm/v3/objects/companies/batch/read', { properties: ['name'], inputs: allIds.slice(i, i + 100).map((id) => ({ id })) });
      for (const c of data.results || []) nameById.set(String(c.id), String(c.properties?.name || '').replace(/\s+/g, ' ').trim());
    }

    const rows = services.map((s) => {
      const p = s.properties || {};
      const ids = companyIdsByService.get(String(s.id)) || [];
      return {
        ServiceID: s.id, ServiceName: String(p.hs_name || '').trim(), Status: p.service_status || '',
        Company: ids.map((id) => nameById.get(id) || `(company ${id})`).join(' | '), CompanyIDs: ids.join(' | '),
        Supplier: p.service_provider || '', SupplierAccount: p.suppliers_account_number || '', WasteType: p.waste_type || '', GeneralWasteType: p.general_waste_type || '',
        BinSize: p.bin_size || '', GLCode: p.revenue_account_code || '', SupplierCost: p.unit_cost_from_service_provider || '', ClientPrice: p.unit_cost_to_client || '',
        BinRental: p.bin_rental || '', ClientMonthlyRent: p.client_monthly_rent || '', SupplierMonthlyRent: p.service_provider_monthly_rent || '', NumberOfBins: p.number_of_bins || '',
      };
    }).sort((a, b) => a.Company.localeCompare(b.Company) || a.ServiceName.localeCompare(b.ServiceName));

    res.setHeader('X-Services', String(rows.length));
    res.setHeader('X-Without-Company', String(rows.filter((r) => !r.Company).length));
    if (format === 'json') return res.status(200).json({ status: 'ok', count: rows.length, rows });

    const csv = [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="rate-card-services.csv"');
    return res.status(200).send(csv);
  } catch (error) {
    return res.status(500).json({ status: 'error', error: error.message });
  }
}
