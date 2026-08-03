const SchoolService = require('../services/school.service');

function ensureSchoolScope(req, res) {
    const authenticatedSchoolId = req.user?.school_id || req.user?.schoolId;

    if (
        authenticatedSchoolId &&
        String(authenticatedSchoolId) !== String(req.params.id)
    ) {
        res.status(404).json({ message: 'Escola nao encontrada.' });
        return false;
    }

    return true;
}

class SchoolController {

    async create(req, res, next) {
        try {
            let createData = { ...req.body };
            
            // Tratamento para JSON stringificado (caso venha via FormData antigo)
            if (createData.address && typeof createData.address === 'string') {
                 try { createData.address = JSON.parse(createData.address); } catch(e) {}
            }
            // Tratamento estruturado se vier via campos individuais
            else if (createData['address[street]']) {
                createData.address = {
                    zipCode: createData['address[zipCode]'] || createData['address[cep]'],
                    street: createData['address[street]'],
                    number: createData['address[number]'],
                    district: createData['address[district]'] || createData['address[neighborhood]'],
                    city: createData['address[city]'],
                    state: createData['address[state]']
                };
            }

            const newSchool = await SchoolService.createSchool(createData, req.file);
            res.status(201).json(newSchool);
        } catch (error) {
            console.error('❌ ERRO [SchoolController.create]:', error.message);
            if (error.code === 11000) { 
                return res.status(409).json({ message: 'Erro de duplicata: Nome ou CNPJ já cadastrado.', error: error.message });
            }
            if (error.name === 'ValidationError') {
                return res.status(400).json({ message: 'Erro de validação.', error: error.message });
            }
            next(error);
        }
    }

    async getAll(req, res, next) {
        try {
            const schools = await SchoolService.getAllSchools();
            res.status(200).json(schools);
        } catch (error) {
            console.error('❌ ERRO [SchoolController.getAll]:', error.message);
            next(error);
        }
    }

    async getById(req, res, next) {
        try {
            if (!ensureSchoolScope(req, res)) return;
            const school = await SchoolService.getSchoolById(req.params.id);
            res.status(200).json(school);
        } catch (error) {
            console.error('❌ ERRO [SchoolController.getById]:', error.message);
            if (error.message.includes('não encontrada')) {
                return res.status(404).json({ message: error.message });
            }
            next(error);
        }
    }

    async getLogo(req, res, next) {
        try {
            const logo = await SchoolService.getSchoolLogo(req.params.id);
            res.set('Content-Type', logo.contentType);
            res.status(200).send(logo.data);
        } catch (error) {
            console.error('❌ ERRO [SchoolController.getLogo]:', error.message);
            if (error.message.includes('não encontrada')) {
                return res.status(404).json({ message: error.message });
            }
            next(error);
        }
    }

    // --- [UPDATE CORRIGIDO COM FLATTEN/DOT NOTATION] ---
    async update(req, res, next) {
        try {
            if (!ensureSchoolScope(req, res)) return;
            console.log('\n\n================================================');
            console.log('🔍 [DEBUG] INÍCIO UPDATE ESCOLA');
            console.log('🆔 ID:', req.params.id);
            console.log('📥 [DEBUG] BODY RECEBIDO (RAW):', JSON.stringify(req.body, null, 2));

            const rawBody = { ...req.body };
            
            // Função recursiva para "achatar" objetos aninhados em Dot Notation
            // Ex: { a: { b: 1 } } vira { "a.b": 1 }
            const flattenObject = (obj, prefix = '') => {
                return Object.keys(obj).reduce((acc, k) => {
                    const pre = prefix.length ? prefix + '.' : '';
                    if (typeof obj[k] === 'object' && obj[k] !== null && !Array.isArray(obj[k])) {
                        Object.assign(acc, flattenObject(obj[k], pre + k));
                    } else {
                        acc[pre + k] = obj[k];
                    }
                    return acc;
                }, {});
            };

            // 1. Convertemos tudo para Dot Notation
            const flatBody = flattenObject(rawBody);
            
            // 2. Filtramos undefined, null e strings vazias/falsas
            const updateData = {};
            Object.keys(flatBody).forEach(key => {
                const val = flatBody[key];
                
                // Ignora campos vazios ou nulos explícitos
                if (
                    val === undefined ||
                    val === null ||
                    val === 'null' ||
                    val === 'undefined' ||
                    (val === '' && key !== 'inepCode')
                ) {
                    return;
                }
                
                // Tratamento especial para arrays de FormData antigos (ex: address[street])
                // Se o flatten já resolveu como 'address.street', usamos ele.
                // Se vier como chave string 'address[street]', convertemos manualmente.
                if (key.includes('[')) {
                    // Lógica legado para FormData manual, se ainda existir
                    const cleanKey = key.replace(/\[/g, '.').replace(/\]/g, '');
                    updateData[cleanKey] = val;
                } else {
                    updateData[key] = val;
                }
            });

            console.log('⚙️ [DEBUG] UPDATE DATA (DOT NOTATION - FINAL):', JSON.stringify(updateData, null, 2));

            // Validação de segurança no log: Se tivermos clientId mas sem chave privada, e estiver em dot notation, OK.
            // Se estivesse como objeto aninhado, seria perigo.
            const hasNestedRisk = Object.keys(updateData).some(k => k === 'coraConfig' || k === 'coraConfig.production');
            if (hasNestedRisk) {
                console.warn('⚠️ [ALERTA CRÍTICO] Objeto aninhado detectado! Isso pode sobrescrever dados.');
            }

            const school = await SchoolService.updateSchool(req.params.id, updateData, req.file);
            
            console.log('✅ [DEBUG] SUCESSO. Escola atualizada.');
            console.log('================================================\n');

            res.status(200).json(school);

        } catch (error) {
            console.error('❌ ERRO [SchoolController.update]:', error.message);
            if (error.message.includes('não encontrada')) return res.status(404).json({ message: error.message });
            next(error);
        }
    }

    async inactivate(req, res, next) {
        try {
            const school = await SchoolService.inactivateSchool(req.params.id);
            res.status(200).json({ message: 'Escola inativada com sucesso', school });
        } catch (error) {
            console.error('❌ ERRO [SchoolController.inactivate]:', error.message);
            if (error.message.includes('não encontrada')) {
                return res.status(404).json({ message: error.message });
            }
            next(error);
        }
    }
}

module.exports = new SchoolController();
