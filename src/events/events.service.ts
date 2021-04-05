import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindConditions, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import { GoogleService } from '../vendor/google.service';
import GooglePlaceDto from '../vendor/google-place.dto';
import ClientFriendlyException from '../shared/exceptions/client-friendly.exception';
import GroupEvent from './entities/event.entity';
import EventCategory from './entities/eventCategory.entity';
import GroupEventDto from './dto/group-event.dto';
import CreateEventDto from './dto/create-event.dto';
import InternalAddress from '../shared/entity/InternalAddress';
import GroupEventSearchDto from './dto/group-event-search.dto';
import { hasValue } from 'src/utils/basicHelpers';

@Injectable()
export class EventsService {
  constructor(
    @InjectRepository(GroupEvent)
    private readonly repository: Repository<GroupEvent>,
    @InjectRepository(EventCategory)
    private readonly categoryRepository: Repository<EventCategory>,
    private googleService: GoogleService,
  ) {}

  async findAll(req: GroupEventSearchDto): Promise<GroupEventDto[]> {
    const filter: FindConditions<GroupEvent> = {};

    if (hasValue(req.parentId)) filter.parentId = req.parentId;
    if (hasValue(req.groupId)) filter.groupId = req.groupId;
    if (hasValue(req.categoryId)) {
      const eventCategory = (await this.categoryRepository.findOne({where: {name: req.categoryId}}));
      if (eventCategory) {filter.categoryId = eventCategory.id;}
    }
    if(hasValue(req.periodStart) && hasValue(req.periodEnd)) {
      filter.startDate = MoreThanOrEqual(req.periodStart);
      filter.endDate = LessThanOrEqual(req.periodEnd);
    }
     
    const data = await this.repository.find({
      relations: ['category', 'group', 'group.members', 'attendance'],
      skip: req.skip,
      take: req.limit,
      where: filter,
    });
    return data.map(this.toDto);
  }

  toDto(data: GroupEvent): GroupEventDto {
    const { group, attendance, ...rest } = data;
    const attendancePercentage =
      (100 * attendance.length) / group.members.length;
    return {
      ...rest,
      attendancePercentage: attendancePercentage.toFixed(2),
      group: {
        id: group.id,
        name: group.name,
        parentId: group.parentId,
        members: [],
      },
      attendance: []
    };
  }

  toListView(event: GroupEvent): GroupEventDto {
    const { group, ...rest } = event;
    return {
      ...rest,
      group: {
        id: group.id,
        name: group.name,
        parentId: group.parentId,
        members: [],
      },
    };
  }

  toDetailView(event: GroupEvent): GroupEventDto {
    const { group, category, ...rest } = event;
    return {
      ...rest,
      group: {
        id: group.id,
        name: group.name,
        parentId: group.parentId,
        members: [],
      },
      category: category ? {id: category.id, name: category.name} : null,
      categoryFields: category.fields,
    };
  }

  async create(data: CreateEventDto): Promise<GroupEventDto> {
    Logger.log(`Create.Event starting ${data.name}`);
    let place: GooglePlaceDto = null;
    if (data.venue.placeId) {
      place = await this.googleService.getPlaceDetails(data.venue.placeId);
    }

    const result = await this.repository
      .createQueryBuilder()
      .insert()
      .values({
        id: 0,
        ...data,
        venue: place,
        attendance: [],
      })
      .execute();
    const insertedId = result.identifiers[0]['id'];
    Logger.log(`Create.Event success name: ${data.name} id:${insertedId}`);

    return this.findOne(insertedId, true);
  }

  async findOne(id: number, full = true): Promise<GroupEventDto> {
    const data = await this.repository.findOne(id, {
      relations: ['category', 'group', 'category.fields'],
    });
    Logger.log(`Read.Event success id:${id}`);
    if (full) {
      Logger.log(`Read.Event loading full scope id:${id}`);

      return this.toDetailView(data);
    }
    return this.toListView(data);
  }

  async update(dto: GroupEventDto): Promise<GroupEventDto> {
    Logger.log(`Update.Event eventId:${dto.id} starting`);
    const currGroup = await this.repository
      .createQueryBuilder()
      .where('id = :id', { id: dto.id })
      .getOne();

    if (!currGroup)
      throw new ClientFriendlyException(`Invalid group ID:${dto.id}`);
    let place: InternalAddress;
    if (dto.venue && dto.venue.placeId !== currGroup.venue?.placeId) {
      Logger.log(`Update.Event eventId:${dto.id} fetching coordinates`);
      place = {
        ...(await this.googleService.getPlaceDetails(dto.venue.placeId)),
      };
    } else {
      place = {
        ...currGroup.venue,
      };
      Logger.log(`Update.Event eventId:${dto.id} using old coordinates`);
    }
    const result = await this.repository
      .createQueryBuilder()
      .update(GroupEvent)
      .set({
        ...dto,
        venue: place,
      })
      .where('id = :id', { id: dto.id })
      .execute();
    if (result.affected)
      Logger.log(
        `Update.Event eventId:${dto.id} affected:${result.affected} complete`,
      );
    return await this.findOne(dto.id, true);
  }

  async remove(id: number): Promise<void> {
    await this.repository.delete(id);
  }

  async exits(name: string): Promise<boolean> {
    const count = await this.repository.count({ where: { name } });
    return count > 0;
  }

  async count(): Promise<number> {
    return await this.repository.count();
  }
}