// Models for the 'blog' app. After changing them run:
//   npx ghuri makemigrations blog
//   npx ghuri migrate
import { User } from '@ghuri/auth'
import {
  BooleanField,
  CASCADE,
  CharField,
  DateTimeField,
  EmailField,
  ForeignKey,
  IntegerField,
  type Manager,
  ManyToManyField,
  Model,
  SlugField,
  TextField,
} from '@ghuri/orm'
import { ImageField } from '@ghuri/storage'

export class Tag extends Model({
  name: new CharField({ maxLength: 50, unique: true }),
  slug: new SlugField({ maxLength: 50, unique: true }),
}) {
  declare static objects: Manager<Tag>
  static Meta = { ordering: ['name'] }

  toString() {
    return this.name
  }
}

export class Post extends Model({
  title: new CharField({ maxLength: 200 }),
  slug: new SlugField({ maxLength: 200, unique: true }),
  body: new TextField({ blank: true }),
  author: new ForeignKey(() => User, { onDelete: CASCADE, relatedName: 'posts' }),
  tags: new ManyToManyField(() => Tag, { blank: true, relatedName: 'posts' }),
  published: new BooleanField({ default: false }),
  cover: new ImageField({
    uploadTo: 'covers/%Y/%m/',
    blank: true,
    widthField: 'coverWidth',
    heightField: 'coverHeight',
  }),
  coverWidth: new IntegerField({ null: true, blank: true, editable: false }),
  coverHeight: new IntegerField({ null: true, blank: true, editable: false }),
  createdAt: new DateTimeField({ autoNowAdd: true }),
  updatedAt: new DateTimeField({ autoNow: true }),
}) {
  declare static objects: Manager<Post>
  static Meta = {
    ordering: ['-createdAt'],
    indexes: [{ fields: ['published', '-createdAt'], name: 'blog_post_pub_created_idx' }],
  }

  toString() {
    return this.title
  }

  getAbsoluteUrl() {
    return `/api/posts/${this.slug}/`
  }
}

export class Comment extends Model({
  post: new ForeignKey(() => Post, { onDelete: CASCADE, relatedName: 'comments' }),
  name: new CharField({ maxLength: 80 }),
  email: new EmailField({ blank: true }),
  body: new TextField(),
  approved: new BooleanField({ default: true }),
  createdAt: new DateTimeField({ autoNowAdd: true }),
}) {
  declare static objects: Manager<Comment>
  static Meta = { ordering: ['createdAt'] }

  toString() {
    return `Comment by ${this.name}`
  }
}
