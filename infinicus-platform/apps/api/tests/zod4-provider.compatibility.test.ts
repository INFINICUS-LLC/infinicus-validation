import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import { z } from 'zod';
import {
  validatorCompiler,
  serializerCompiler,
  jsonSchemaTransform,
} from 'fastify-type-provider-zod';

async function createTestApp() {
  const app = Fastify();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Zod Compatibility Test',
        version: '1.0.0',
      },
    },
    transform: jsonSchemaTransform,
  });

  app.post('/compatibility', {
    schema: {
      body: z.object({
        name: z.string().min(1),
      }).strict(),
      response: {
        200: z.object({
          accepted: z.boolean(),
          name: z.string(),
        }),
      },
    },
  }, async (request) => {
    const body = request.body as { name: string };

    return {
      accepted: true,
      name: body.name,
      internalOnly: 'must-not-leak',
    };
  });

  await app.ready();
  return app;
}

describe('Zod 4 Fastify provider compatibility', () => {
  it('accepts valid request payloads', async () => {
    const app = await createTestApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/compatibility',
        payload: { name: 'INFINICUS' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        accepted: true,
        name: 'INFINICUS',
      });
    } finally {
      await app.close();
    }
  });

  it('rejects invalid and unauthorized extra fields', async () => {
    const app = await createTestApp();

    try {
      for (const payload of [
        { name: '' },
        { name: 'INFINICUS', tenantId: 'forged' },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/compatibility',
          payload,
        });

        expect(response.statusCode).toBe(400);
      }
    } finally {
      await app.close();
    }
  });

  it('does not serialize undeclared response fields', async () => {
    const app = await createTestApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/compatibility',
        payload: { name: 'INFINICUS' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).not.toHaveProperty('internalOnly');
    } finally {
      await app.close();
    }
  });

  it('generates the expected OpenAPI contract', async () => {
    const app = await createTestApp();

    try {
      const spec = app.swagger() as {
        paths: Record<string, {
          post?: {
            requestBody?: unknown;
            responses?: Record<string, unknown>;
          };
        }>;
      };

      expect(spec.paths['/compatibility']).toBeDefined();

      const operation = spec.paths['/compatibility'].post;

      expect(operation?.requestBody).toBeDefined();
      expect(operation?.responses?.['200']).toBeDefined();
    } finally {
      await app.close();
    }
  });
});
