const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const uri = process.env.REGISTRATION_TEST_MONGO_URI;

test('real database: 2026 and 2027 requests, edit, approval and occupancy', { skip: !uri }, async () => {
  const dbName = `academyhub_registration_test_${process.pid}_${Date.now()}`;
  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 5000 });
  const School = require('../../api/models/school.model');
  const Class = require('../../api/models/class.model');
  const Plan = require('../../api/models/academicMonthlyFeePlan.model');
  const Enrollment = require('../../api/models/enrollment.model');
  const Registration = require('../../api/models/registration-request.model');
  const service = require('../../api/services/registration-request.service');
  const occupancy = require('../../api/services/classOccupancy.service');
  const notification = require('../../api/services/appNotification.service');
  const originalNotification = notification.createFromRealtimeEvent;
  notification.createFromRealtimeEvent = async () => {};
  process.env.JWT_SECRET = 'registration-integration-isolated-secret';
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/registration-requests', require('../../api/routes/registration-request.routes'));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/registration-requests`;
  const actor = new mongoose.Types.ObjectId();
  try {
    await Class.init();
    const school = await School.create({ name: 'Escola teste isolada' });
    const jwt = require('jsonwebtoken').sign({ id: String(actor), school_id: String(school._id), roles: ['admin'] }, process.env.JWT_SECRET);
    const api = async (path, { method = 'GET', body, authorized = false } = {}) => {
      const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${jwt}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = await response.json();
      assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
      return data;
    };
    const source = await Class.create({ school_id: school._id, schoolYear: 2026, name: '1A', level: 'Ensino Fundamental I', grade: '1º Ano', shift: 'Matutino', monthlyFee: 400, capacity: 5, status: 'Ativa' });
    await Plan.create({ school_id: school._id, academicYear: 2027, level: source.level, grade: source.grade, shift: source.shift, publishedCents: 52500, publishedVersion: 1 });
    const y26 = await api(`/public/${school._id}/classes?academicYear=2026`);
    const y27 = await api(`/public/${school._id}/classes?academicYear=2027`);
    assert.equal(y26[0].monthlyFee, 400);
    assert.equal(y27[0].monthlyFee, 525);
    assert.equal(y27[0].id, `planning:2027:${source._id}`);
    const student = (name, cpf) => ({ fullName: name, cpf, birthDate: '2000-01-01', gender: 'Outro', race: 'Parda', nationality: 'Brasileira', address: { street: 'Rua A', neighborhood: 'Centro', city: 'Teste', state: 'PA' } });
    const make = (name, cpf, year, destination) => service.createPublicRequest({ school_id: school._id, registrationType: 'ADULT_STUDENT', academicYearTo: year, selectedClassId: destination, studentData: student(name, cpf) });
    const first = await make('Pessoa Um', '52998224725', 2026, String(source._id));
    const submitted = await api('/public/submit', { method: 'POST', body: { school_id: String(school._id), registrationType: 'ADULT_STUDENT', academicYearTo: 2027, selectedClassId: y27[0].id, studentData: student('Pessoa Dois', '11144477735') } });
    const second = await Registration.findById(submitted.requestId);
    assert.equal(second.selectedClassSnapshot.pricingVersion, 1);
    assert.ok(second.selectedClassSnapshot.pricingVersionId);
    const third = await make('Pessoa Tres', '12345678909', 2026, String(source._id));
    await api(`/${third._id}`, { method: 'PUT', authorized: true, body: { academicYearTo: 2027, selectedClassId: y27[0].id } });
    const legacy = await service.createPublicRequest({ school_id: school._id, registrationType: 'ADULT_STUDENT', studentData: student('Legado', '52998224725') });
    assert.equal(legacy.academicYearTo, undefined);
    const approved26 = await service.approveRequest(first._id, school._id, actor);
    const approved27 = await api(`/${second._id}/approve`, { method: 'POST', authorized: true, body: {} });
    const approvedEdited = await service.approveRequest(third._id, school._id, actor);
    assert.equal(approved26.enrollment.academicYear, 2026);
    assert.equal(approved26.enrollment.agreedFee, 400);
    assert.equal(approved27.enrollment.academicYear, 2027);
    assert.equal(approved27.enrollment.agreedFee, 525);
    assert.equal(String(approvedEdited.enrollment.class), String(approved27.enrollment.class));
    assert.equal(await Class.countDocuments({ school_id: school._id, schoolYear: 2027 }), 1);
    assert.equal(await Enrollment.countDocuments({ school_id: school._id, academicYear: 2026, status: 'Ativa' }), 1);
    const view = await occupancy.load(school._id, 2027);
    assert.equal(view.rows.find(r => r.name === '1A').confirmed, 2);
    const capacityClass = await Class.create({ school_id: school._id, schoolYear: 2026, name: '1B', level: source.level, grade: source.grade, shift: source.shift, monthlyFee: 400, capacity: 1, status: 'Ativa' });
    const limitedId = `planning:2027:${capacityClass._id}`;
    const concurrent = await Promise.all([
      make('Pessoa Quatro', '39053344705', 2027, limitedId),
      make('Pessoa Cinco', '16899535009', 2027, limitedId),
    ]);
    const approvals = await Promise.allSettled(concurrent.map(r => service.approveRequest(r._id, school._id, actor)));
    assert.equal(approvals.filter(r => r.status === 'fulfilled').length, 1);
    const remaining = concurrent[approvals.findIndex(r => r.status === 'rejected')];
    await assert.rejects(service.approveRequest(remaining._id, school._id, actor), e => e.statusCode === 409);
    assert.equal(await Class.countDocuments({ school_id: school._id, schoolYear: 2027, name: '1B' }), 1);
    const destination = await Class.findOne({ school_id: school._id, schoolYear: 2027, name: '1B' });
    assert.equal(await Enrollment.countDocuments({ class: destination._id, status: 'Ativa' }), 1);
    const planned = await Class.create({ school_id: school._id, schoolYear: 2027, name: '1C', level: source.level, grade: source.grade, shift: source.shift, monthlyFee: 1, capacity: 3, status: 'Planejada' });
    const plannedRequest = await make('Destino Planejado', '01234567890', 2027, String(planned._id));
    const plannedApproval = await service.approveRequest(plannedRequest._id, school._id, actor);
    assert.equal(plannedApproval.enrollment.agreedFee, 525);
    assert.equal((await Class.findById(planned._id)).status, 'Ativa');
    const duplicate = await make('Cadastro duplicado', '52998224725', 2027, String(approved27.enrollment.class));
    await assert.rejects(service.approveRequest(duplicate._id, school._id, actor), e => e.statusCode === 409 && /CPF/.test(e.message));
    const changedPrice = await make('Mudanca de valor', '93541134780', 2027, String(approved27.enrollment.class));
    await Plan.updateOne({ school_id: school._id, academicYear: 2027 }, { $set: { publishedCents: 60000 } });
    await assert.rejects(service.approveRequest(changedPrice._id, school._id, actor), e => e.statusCode === 409);
    const refreshed = await service.updateRequestData(changedPrice._id, school._id, actor, { academicYearTo: 2027, selectedClassId: String(approved27.enrollment.class) });
    assert.equal(refreshed.selectedClassSnapshot.monthlyFee, 600);
    const editRace = await make('Edicao concorrente', '86288366757', 2026, String(source._id));
    const racing = await Promise.allSettled([
      service.updateRequestData(editRace._id, school._id, actor, { academicYearTo: 2027, selectedClassId: String(approved27.enrollment.class) }),
      service.approveRequest(editRace._id, school._id, actor),
    ]);
    assert.equal(racing.filter(r => r.status === 'fulfilled').length, 1);
    const savedRace = await Registration.findById(editRace._id);
    if (savedRace.status === 'APPROVED') assert.equal(savedRace.academicYearTo, 2026);
    else assert.equal(savedRace.academicYearTo, 2027);
    const otherSchool = await School.create({ name: 'Outra escola isolada' });
    const unpublished = await Class.create({ school_id: otherSchool._id, schoolYear: 2026, name: 'Sem preço', level: source.level, grade: source.grade, shift: source.shift, monthlyFee: 100, status: 'Ativa' });
    const otherCatalogue = await service.listPublicClasses(otherSchool._id, 2027);
    assert.equal(otherCatalogue[0].availabilityStatus, 'unavailable');
    assert.equal(otherCatalogue[0].monthlyFee, null);
    await assert.rejects(service.createPublicRequest({ school_id: otherSchool._id, registrationType: 'ADULT_STUDENT', academicYearTo: 2027, selectedClassId: `planning:2027:${unpublished._id}`, studentData: student('Sem preço', '86288366757') }), e => e.statusCode === 409);
    await assert.rejects(service.createPublicRequest({ school_id: otherSchool._id, registrationType: 'ADULT_STUDENT', academicYearTo: 2026, selectedClassId: String(source._id), studentData: student('Escola errada', '86288366757') }), e => e.statusCode === 409);
  } finally {
    await new Promise(resolve => server.close(resolve));
    notification.createFromRealtimeEvent = originalNotification;
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
