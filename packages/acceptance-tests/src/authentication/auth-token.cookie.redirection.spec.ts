// std
import { deepStrictEqual, strictEqual } from 'assert';

// 3p
import {
  Column, createConnection, Entity, getConnection, getRepository,
  PrimaryGeneratedColumn
} from '@foal/typeorm/node_modules/typeorm';
import * as request from 'supertest';

// FoalTS
import {
  Context, controller, createApp, dependency, Get, hashPassword,
  HttpResponseOK, HttpResponseRedirect, Post, removeSessionCookie,
  Session, setSessionCookie, TokenRequired, ValidateBody, verifyPassword
} from '@foal/core';
import { FoalSession, TypeORMStore } from '@foal/typeorm';

describe('[Authentication|auth token|cookie|redirection] Users', () => {

  let app: any;
  let token: string;

  @Entity()
  class User {
    @PrimaryGeneratedColumn()
    id: number;

    @Column({ unique: true })
    email: string;

    @Column()
    password: string;
  }

  @TokenRequired({ store: TypeORMStore, cookie: true })
  class ApiController {
    @Get('/products')
    readProducts() {
      return new HttpResponseOK([]);
    }
  }

  class LoginController {
    @dependency
    store: TypeORMStore;

    @Get('/logout')
    @TokenRequired({ store: TypeORMStore, cookie: true })
    async logout(ctx: Context<any, Session>) {
      await this.store.destroy(ctx.session.sessionID);
      const response = new HttpResponseRedirect('/login');
      removeSessionCookie(response);
      return response;
    }

    @Post('/login')
    @ValidateBody({
      additionalProperties: false,
      properties: {
        email: { type: 'string', format: 'email' },
        password: { type: 'string' }
      },
      required: [ 'email', 'password' ],
      type: 'object',
    })
    async login(ctx: Context) {
      const user = await getRepository(User).findOne({ email: ctx.request.body.email });

      if (!user) {
        return new HttpResponseRedirect('/login');
      }

      if (!await verifyPassword(ctx.request.body.password, user.password)) {
        return new HttpResponseRedirect('/login');
      }

      const session = await this.store.createAndSaveSessionFromUser(user);
      const response = new HttpResponseRedirect('/home');
      setSessionCookie(response, session);
      return response;
    }

    @Get('/home')
    @TokenRequired({ store: TypeORMStore, cookie: true, redirectTo: '/login' })
    home() {
      return new HttpResponseOK('Home page');
    }
  }

  class AppController {
    subControllers = [
      controller('', LoginController),
      controller('/api', ApiController),
    ];
  }

  before(async () => {
    process.env.SETTINGS_SESSION_SECRET = 'session-secret';
    await createConnection({
      database: 'e2e_db.sqlite',
      dropSchema: true,
      entities: [ User, FoalSession ],
      synchronize: true,
      type: 'sqlite',
    });

    const user = new User();
    user.email = 'john@foalts.org';
    user.password = await hashPassword('password');
    await getRepository(User).save(user);

    app = createApp(AppController);
  });

  after(async () => {
    await getConnection().close();
    delete process.env.SETTINGS_SESSION_SECRET;
  });

  it('cannot access protected routes if they are not logged in.', async () => {
    await request(app)
      .get('/api/products')
      .expect(400)
      .expect({
        code: 'invalid_request',
        description: 'Auth cookie not found.'
      });

    await request(app)
      .get('/home')
      .expect(302)
      .expect('Location', '/login');
  });

  it('can log in.', async () => {
    // Try to login with a wrong email
    await request(app)
      .post('/login')
      .send({ email: 'mary@foalts.org', password: 'password' })
      .expect(302)
      .expect('location', '/login');

    // Try to login with a wrong email
    await request(app)
      .post('/login')
      .send({ email: 'john@foalts.org', password: 'wrong_password' })
      .expect(302)
      .expect('location', '/login');

    // Login with a correct email
    await request(app)
      .post('/login')
      .send({ email: 'john@foalts.org', password: 'password' })
      .expect(302)
      .expect('location', '/home')
      .then(response => {
        strictEqual(Array.isArray(response.header['set-cookie']), true);
        token = response.header['set-cookie'][0].split('auth=')[1].split(';')[0];
      });
  });

  it('can access routes once they are logged in.', () => {
    return request(app)
      .get('/api/products')
      .set('Cookie', `auth=${token}`)
      .expect(200)
      .then(response => {
        deepStrictEqual(response.body, []);
      });
  });

  it('can log out.', () => {
    return request(app)
      .get('/logout')
      .set('Cookie', `auth=${token}`)
      .expect(302)
      .expect('location', '/login')
      .then(response => {
        strictEqual(Array.isArray(response.header['set-cookie']), true);
        strictEqual(response.header['set-cookie'][0].split('Max-Age=')[1].split(';')[0], '0');
      });
  });

  it('cannot access routes once they are logged out.', async () => {
    await request(app)
      .get('/api/products')
      .set('Cookie', `auth=${token}`)
      .expect(401)
      .expect({
        code: 'invalid_token',
        description: 'token invalid or expired'
      });

    await request(app)
      .get('/home')
      .set('Cookie', `auth=${token}`)
      .expect(302)
      .expect('Location', '/login');
  });

});
